package com.ryspa.mousse.client;

import android.os.Bundle;
import android.util.Log;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // When the WebView's renderer dies (a GPU driver fault, or Android reclaiming memory),
        // Android ends the whole app unless someone handles it. Start the screen again instead.
        bridge.addWebViewListener(new WebViewListener() {
            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                Log.w("Mousse", "WebView renderer gone (crashed: " + detail.didCrash() + "); starting the screen again");
                recreate();
                return true;
            }
        });
    }
}
