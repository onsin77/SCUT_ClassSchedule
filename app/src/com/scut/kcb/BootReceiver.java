package com.scut.kcb;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context ctx, Intent intent) {
        String a = intent.getAction();
        if (a == null) return;
        if (a.equals(Intent.ACTION_BOOT_COMPLETED)
                || a.equals(Intent.ACTION_MY_PACKAGE_REPLACED)
                || a.equals("android.intent.action.QUICKBOOT_POWERON")) {
            MainActivity.restoreAlarms(ctx);
        }
    }
}
