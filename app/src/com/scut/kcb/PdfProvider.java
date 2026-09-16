package com.scut.kcb;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * 极简 ContentProvider：把应用缓存目录里的 PDF 暴露成 content:// 给分享面板用。
 * 没有 AndroidX 就用不了 FileProvider，所以自己写一个（只读、不导出）。
 */
public class PdfProvider extends ContentProvider {

    public static final String AUTHORITY = "com.scut.kcb.files";

    /** 构造一个带友好显示名的分享 URI */
    public static Uri uriFor(String fileName, String displayName) {
        return uriFor(fileName, displayName, null);
    }

    /** 同上，另外带上 MIME（备注附件要靠它找到能打开的应用） */
    public static Uri uriFor(String fileName, String displayName, String mime) {
        Uri.Builder b = new Uri.Builder()
                .scheme("content")
                .authority(AUTHORITY)
                .appendPath(fileName);
        if (displayName != null && !displayName.isEmpty()) b.appendQueryParameter("name", displayName);
        if (mime != null && !mime.isEmpty()) b.appendQueryParameter("type", mime);
        return b.build();
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    private File resolve(Uri uri) {
        String seg = uri.getLastPathSegment();
        if (seg == null || seg.isEmpty()) seg = "share.pdf";
        return new File(getContext().getCacheDir(), seg);
    }

    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        return ParcelFileDescriptor.open(resolve(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(Uri uri) {
        String t = uri.getQueryParameter("type");
        return (t == null || t.isEmpty()) ? "application/pdf" : t;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        File f = resolve(uri);
        String[] cols = (projection != null && projection.length > 0)
                ? projection
                : new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE};
        MatrixCursor c = new MatrixCursor(cols, 1);
        String name = uri.getQueryParameter("name");
        if (name == null || name.isEmpty()) name = f.getName();
        Object[] row = new Object[cols.length];
        for (int i = 0; i < cols.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(cols[i])) row[i] = name;
            else if (OpenableColumns.SIZE.equals(cols[i])) row[i] = f.length();
            else row[i] = null;
        }
        c.addRow(row);
        return c;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null;
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0;
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0;
    }
}
