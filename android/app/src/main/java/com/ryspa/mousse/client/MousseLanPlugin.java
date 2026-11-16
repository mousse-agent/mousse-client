package com.ryspa.mousse.client;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.wifi.WifiManager;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.MulticastSocket;
import java.net.NetworkInterface;
import java.net.Socket;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * A bounded byte pipe to a paired computer on the same Wi-Fi, for when the internet (and so the
 * cloud relay) is down. The WebView cannot open raw TCP or UDP, so this plugin opens TCP sockets to
 * private LAN addresses and listens for the computer's multicast adverts. It authenticates nothing:
 * TLS with a pinned key and advert decryption run in JS. It never logs addresses or payloads.
 */
@CapacitorPlugin(name = "MousseLan")
public class MousseLanPlugin extends Plugin {

    private static final int MAX_SOCKETS = 8;
    private static final int READ_BUFFER = 64 * 1024;
    private static final int MAX_WRITE = 1024 * 1024;
    private static final int DISCOVERY_PORT = 47777;
    private static final String DISCOVERY_GROUP = "239.255.77.77";
    private static final int ADVERT_LENGTH = 48;
    private static final int ADVERT_BUDGET = 128;
    private static final long ADVERT_WINDOW_MS = 5000;

    private final Map<String, Conn> conns = new ConcurrentHashMap<>();
    private final ExecutorService connectExecutor = Executors.newCachedThreadPool();
    private final Object discoveryLock = new Object();
    private Discovery discovery;
    private WifiManager.MulticastLock multicastLock;

    // ---- TCP ----

    private final class Conn {
        final String id;
        final Socket socket;
        final ExecutorService writer = Executors.newSingleThreadExecutor();
        final AtomicBoolean closed = new AtomicBoolean(false);

        Conn(String id, Socket socket) {
            this.id = id;
            this.socket = socket;
        }

        /** Releases the socket and emits 'tcpClosed' exactly once. */
        void close(boolean error) {
            if (!closed.compareAndSet(false, true)) return;
            conns.remove(id);
            try {
                socket.close();
            } catch (IOException ignored) {}
            writer.shutdownNow();
            JSObject event = new JSObject();
            event.put("id", id);
            event.put("error", error);
            notifyListeners("tcpClosed", event);
        }
    }

    @PluginMethod
    public void tcpConnect(PluginCall call) {
        String host = call.getString("host");
        Integer port = call.getInt("port");
        Integer timeoutArg = call.getInt("timeoutMs");
        byte[] address = parsePrivateIPv4(host);
        if (address == null) {
            call.reject("host must be a private IPv4 address");
            return;
        }
        if (port == null || port < 1 || port > 65535) {
            call.reject("port out of range");
            return;
        }
        int timeoutMs = timeoutArg == null ? 15000 : Math.max(1, Math.min(15000, timeoutArg));
        if (conns.size() >= MAX_SOCKETS) {
            call.reject("too many open sockets");
            return;
        }
        final int portValue = port;
        connectExecutor.execute(() -> connect(call, address, portValue, timeoutMs));
    }

    private void connect(PluginCall call, byte[] address, int port, int timeoutMs) {
        Socket socket = new Socket();
        try {
            Network lan = findLanNetwork();
            if (lan != null) {
                try {
                    lan.bindSocket(socket);
                } catch (IOException | RuntimeException bindFailed) {
                    // An unbound socket may still reach the LAN when there is no other default network.
                    try {
                        socket.close();
                    } catch (IOException ignored) {}
                    socket = new Socket();
                }
            }
            socket.setTcpNoDelay(true);
            socket.setKeepAlive(true);
            socket.connect(new InetSocketAddress(InetAddress.getByAddress(address), port), timeoutMs);
        } catch (IOException | RuntimeException e) {
            try {
                socket.close();
            } catch (IOException ignored) {}
            call.reject("connect failed");
            return;
        }
        // Re-check the cap after connecting: several connects may have been in flight at once.
        synchronized (conns) {
            if (conns.size() >= MAX_SOCKETS) {
                try {
                    socket.close();
                } catch (IOException ignored) {}
                call.reject("too many open sockets");
                return;
            }
            String id = UUID.randomUUID().toString();
            Conn conn = new Conn(id, socket);
            conns.put(id, conn);
            JSObject result = new JSObject();
            result.put("id", id);
            call.resolve(result);
            Thread reader = new Thread(() -> readLoop(conn), "mousse-lan-read");
            reader.setDaemon(true);
            reader.start();
        }
    }

    private void readLoop(Conn conn) {
        byte[] buffer = new byte[READ_BUFFER];
        boolean error = false;
        try {
            InputStream in = conn.socket.getInputStream();
            while (true) {
                int n = in.read(buffer);
                if (n < 0) break;
                if (n == 0) continue;
                JSObject event = new JSObject();
                event.put("id", conn.id);
                event.put("data", Base64.encodeToString(buffer, 0, n, Base64.NO_WRAP));
                notifyListeners("tcpData", event);
            }
        } catch (IOException | RuntimeException e) {
            error = true;
        }
        // A close requested from JS has already emitted 'tcpClosed'; close() is a no-op then.
        conn.close(error);
    }

    @PluginMethod
    public void tcpWrite(PluginCall call) {
        String id = call.getString("id");
        String data = call.getString("data");
        Conn conn = id == null ? null : conns.get(id);
        if (conn == null || conn.closed.get()) {
            call.reject("socket closed");
            return;
        }
        if (data == null) {
            call.reject("data missing");
            return;
        }
        // Base64 is 4 characters per 3 bytes; reject obviously oversized input before decoding.
        if ((long) data.length() * 3 / 4 > MAX_WRITE + 3) {
            call.reject("write too large");
            return;
        }
        byte[] bytes;
        try {
            bytes = Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("data is not base64");
            return;
        }
        if (bytes.length > MAX_WRITE) {
            call.reject("write too large");
            return;
        }
        try {
            conn.writer.execute(() -> {
                if (conn.closed.get()) {
                    call.reject("socket closed");
                    return;
                }
                try {
                    OutputStream out = conn.socket.getOutputStream();
                    out.write(bytes);
                    out.flush();
                    call.resolve();
                } catch (IOException | RuntimeException e) {
                    call.reject("write failed");
                    conn.close(true);
                }
            });
        } catch (RejectedExecutionException e) {
            call.reject("socket closed");
        }
    }

    @PluginMethod
    public void tcpClose(PluginCall call) {
        String id = call.getString("id");
        Conn conn = id == null ? null : conns.get(id);
        if (conn != null) conn.close(false);
        call.resolve();
    }

    /** Parses a dotted IPv4 literal in 10/8, 172.16/12, 192.168/16 or 100.64/10; null otherwise. */
    private static byte[] parsePrivateIPv4(String host) {
        if (host == null) return null;
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) return null;
        int[] o = new int[4];
        for (int i = 0; i < 4; i++) {
            String p = parts[i];
            if (p.isEmpty() || p.length() > 3) return null;
            for (int j = 0; j < p.length(); j++) {
                char c = p.charAt(j);
                if (c < '0' || c > '9') return null;
            }
            // No leading zeros: some parsers read them as octal.
            if (p.length() > 1 && p.charAt(0) == '0') return null;
            o[i] = Integer.parseInt(p);
            if (o[i] > 255) return null;
        }
        boolean allowed =
            o[0] == 10 ||
            (o[0] == 172 && o[1] >= 16 && o[1] <= 31) ||
            (o[0] == 192 && o[1] == 168) ||
            (o[0] == 100 && o[1] >= 64 && o[1] <= 127);
        if (!allowed) return null;
        return new byte[] { (byte) o[0], (byte) o[1], (byte) o[2], (byte) o[3] };
    }

    /** A Wi-Fi network, else an Ethernet one, else null. */
    private Network findLanNetwork() {
        ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return null;
        Network ethernet = null;
        try {
            for (Network network : cm.getAllNetworks()) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(network);
                if (caps == null) continue;
                if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return network;
                if (ethernet == null && caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) ethernet = network;
            }
        } catch (RuntimeException ignored) {}
        return ethernet;
    }

    // ---- Discovery ----

    private final class Discovery {
        final MulticastSocket socket;
        final InetSocketAddress group;
        final NetworkInterface iface;
        final AtomicBoolean stopped = new AtomicBoolean(false);
        Thread thread;

        Discovery(MulticastSocket socket, InetSocketAddress group, NetworkInterface iface) {
            this.socket = socket;
            this.group = group;
            this.iface = iface;
        }

        void stop() {
            if (!stopped.compareAndSet(false, true)) return;
            try {
                socket.leaveGroup(group, iface);
            } catch (IOException | RuntimeException ignored) {}
            socket.close();
            if (thread != null) thread.interrupt();
        }
    }

    @PluginMethod
    public void discoveryStart(PluginCall call) {
        synchronized (discoveryLock) {
            // Calling again re-joins: the Wi-Fi network may have changed.
            stopDiscoveryLocked(false);
            Network lan = findLanNetwork();
            NetworkInterface iface = null;
            if (lan != null) {
                try {
                    ConnectivityManager cm = (ConnectivityManager) getContext().getSystemService(Context.CONNECTIVITY_SERVICE);
                    LinkProperties link = cm == null ? null : cm.getLinkProperties(lan);
                    String name = link == null ? null : link.getInterfaceName();
                    if (name != null) iface = NetworkInterface.getByName(name);
                } catch (IOException | RuntimeException ignored) {}
            }
            MulticastSocket socket = null;
            InetSocketAddress group;
            try {
                socket = new MulticastSocket(null);
                socket.setReuseAddress(true);
                socket.bind(new InetSocketAddress(DISCOVERY_PORT));
                group = new InetSocketAddress(InetAddress.getByName(DISCOVERY_GROUP), DISCOVERY_PORT);
            } catch (IOException | RuntimeException e) {
                if (socket != null) socket.close();
                call.reject("discovery socket failed");
                return;
            }
            if (lan != null) {
                try {
                    lan.bindSocket(socket);
                } catch (IOException | RuntimeException ignored) {}
            }
            try {
                socket.joinGroup(group, iface);
            } catch (IOException | RuntimeException ignored) {
                if (iface != null) {
                    // Fall back to the default interface.
                    iface = null;
                    try {
                        socket.joinGroup(group, null);
                    } catch (IOException | RuntimeException ignoredToo) {}
                }
            }
            acquireMulticastLock();
            Discovery d = new Discovery(socket, group, iface);
            Thread thread = new Thread(() -> receiveLoop(d), "mousse-lan-discovery");
            thread.setDaemon(true);
            d.thread = thread;
            discovery = d;
            thread.start();
            call.resolve();
        }
    }

    @PluginMethod
    public void discoveryStop(PluginCall call) {
        synchronized (discoveryLock) {
            stopDiscoveryLocked(true);
        }
        call.resolve();
    }

    private void stopDiscoveryLocked(boolean releaseLock) {
        if (discovery != null) {
            discovery.stop();
            discovery = null;
        }
        if (releaseLock) releaseMulticastLock();
    }

    private void receiveLoop(Discovery d) {
        byte[] buffer = new byte[ADVERT_LENGTH + 1];
        long windowStart = System.currentTimeMillis();
        int forwarded = 0;
        while (!d.stopped.get()) {
            DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
            try {
                d.socket.receive(packet);
            } catch (IOException | RuntimeException e) {
                if (d.stopped.get()) return;
                // Best effort: back off briefly rather than spinning on a broken socket.
                try {
                    Thread.sleep(500);
                } catch (InterruptedException interrupted) {
                    return;
                }
                continue;
            }
            // A 49-byte buffer means a longer packet shows as 49 bytes and is dropped.
            if (packet.getLength() != ADVERT_LENGTH) continue;
            byte[] data = packet.getData();
            int off = packet.getOffset();
            if (data[off] != 'M' || data[off + 1] != 'L' || data[off + 2] != 'N' || data[off + 3] != '1') continue;
            InetAddress source = packet.getAddress();
            if (!(source instanceof Inet4Address)) continue;
            long now = System.currentTimeMillis();
            if (now - windowStart >= ADVERT_WINDOW_MS || now < windowStart) {
                windowStart = now;
                forwarded = 0;
            }
            if (forwarded >= ADVERT_BUDGET) continue;
            forwarded++;
            JSObject event = new JSObject();
            event.put("address", source.getHostAddress());
            event.put("data", Base64.encodeToString(data, off, ADVERT_LENGTH, Base64.NO_WRAP));
            notifyListeners("lanAdvert", event);
        }
    }

    private void acquireMulticastLock() {
        try {
            if (multicastLock == null) {
                WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wifi == null) return;
                multicastLock = wifi.createMulticastLock("mousse-lan");
                multicastLock.setReferenceCounted(false);
            }
            if (!multicastLock.isHeld()) multicastLock.acquire();
        } catch (RuntimeException ignored) {}
    }

    private void releaseMulticastLock() {
        try {
            if (multicastLock != null && multicastLock.isHeld()) multicastLock.release();
        } catch (RuntimeException ignored) {}
    }

    @Override
    protected void handleOnDestroy() {
        synchronized (discoveryLock) {
            stopDiscoveryLocked(true);
        }
        List<Conn> open = new ArrayList<>(conns.values());
        for (Conn conn : open) conn.close(false);
        connectExecutor.shutdownNow();
        super.handleOnDestroy();
    }
}
