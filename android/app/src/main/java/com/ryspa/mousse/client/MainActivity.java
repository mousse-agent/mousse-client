package com.ryspa.mousse.client;

import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
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
        keepWebViewAboveKeyboard(bridge.getWebView());
    }

    /**
     * The app draws edge to edge (the status bar overlays the WebView, and Android 15 enforces it),
     * so Android no longer shrinks the window when the keyboard opens. Left alone, the keyboard
     * either covers the bottom of the page or, in newer WebViews, shrinks only the visual viewport:
     * the page keeps its full height under the keyboard, and a swipe on the composer pans the whole
     * screen up into that hidden strip. Ending the WebView at the top of the keyboard instead gives
     * the page the space it can really show, so there is nothing to pan.
     */
    private static void keepWebViewAboveKeyboard(WebView webView) {
        // Listen on the WebView's parent: a listener on the WebView itself would replace the
        // WebView's own, which turns the page's safe-area insets into zero.
        View parent = (View) webView.getParent();
        ViewCompat.setOnApplyWindowInsetsListener(parent, (view, insets) -> {
            int keyboard = insets.isVisible(WindowInsetsCompat.Type.ime())
                ? insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
                : 0;
            ViewGroup.MarginLayoutParams params = (ViewGroup.MarginLayoutParams) webView.getLayoutParams();
            if (params.bottomMargin != keyboard) {
                params.bottomMargin = keyboard;
                webView.setLayoutParams(params);
            }
            // The keyboard is handled here, so the WebView must not also shrink its visual viewport for it.
            return new WindowInsetsCompat.Builder(insets)
                .setInsets(WindowInsetsCompat.Type.ime(), Insets.NONE)
                .setVisible(WindowInsetsCompat.Type.ime(), false)
                .build();
        });
    }
}
