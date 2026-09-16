package com.scut.kcb;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;

import org.json.JSONObject;

public class ReminderReceiver extends BroadcastReceiver {

    /** 备注里带的图片（缩略图）存在 SharedPreferences 里，到点才解码，别常驻内存 */
    private static Bitmap loadImage(Context ctx, String key) {
        if (key == null || key.isEmpty()) return null;
        try {
            String json = ctx.getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE)
                    .getString("alarmImgs", "{}");
            String url = new JSONObject(json).optString(key, "");
            int comma = url.indexOf(',');
            if (comma < 0) return null;
            byte[] bytes = Base64.decode(url.substring(comma + 1), Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (Throwable t) {
            return null;
        }
    }

    @Override
    public void onReceive(Context ctx, Intent intent) {
        String id = intent.getStringExtra("id");
        String title = intent.getStringExtra("title");
        String body = intent.getStringExtra("body");
        String channel = intent.getStringExtra("channel");
        if (title == null) title = "华工课程表";
        if (channel == null) channel = MainActivity.CH_PRECLASS;

        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);

        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(ctx, id == null ? 0 : id.hashCode(), open, flags);

        String text = body == null ? "" : body;
        Notification.Style style = new Notification.BigTextStyle().bigText(text);
        Bitmap pic = loadImage(ctx, intent.getStringExtra("img"));
        if (pic != null) {
            // 备注里有图片就直接铺成大图，展开通知就能看到。
            // 注意 BigPictureStyle 没有 bigText()，正文只能走 setContentText。
            style = new Notification.BigPictureStyle().bigPicture(pic).setBigContentTitle(title);
        }

        Notification.Builder b = new Notification.Builder(ctx, channel)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(style)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .setWhen(System.currentTimeMillis())
                .setShowWhen(true);

        if (MainActivity.CH_PRECLASS.equals(channel)) {
            b.setCategory(Notification.CATEGORY_REMINDER);
            b.setPriority(Notification.PRIORITY_HIGH);
            b.setDefaults(Notification.DEFAULT_VIBRATE | Notification.DEFAULT_LIGHTS);
        } else {
            b.setCategory(Notification.CATEGORY_STATUS);
        }

        nm.notify(id == null ? 1 : id.hashCode(), b.build());
    }
}
