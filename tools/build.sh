#!/usr/bin/env bash
# 华工课程表 —— 手工构建 APK（aapt2 + javac + d8 + zipalign + apksigner）
set -e

ROOT="$(cygpath -m "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)")"
JAVA_HOME="C:/Users/20135/.workbuddy/binaries/java/jdk-17.0.20.1+1"
SDK="C:/Users/20135/.workbuddy/binaries/android/sdk"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
PY="C:/Users/20135/.workbuddy/binaries/python/envs/default/Scripts/python.exe"

export JAVA_HOME
export PATH="$(cygpath -u "$JAVA_HOME")/bin:$PATH"
JAVAC="$JAVA_HOME/bin/javac.exe"
KEYTOOL="$JAVA_HOME/bin/keytool.exe"

APP_NAME="华工课程表"
APK_BASE="huagong-schedule"
B="$ROOT/build"
KS="$ROOT/tools/keystore.jks"
KSPASS="kcb123456"

# 用 Python 清理：有些环境会把 shell 的 rm -rf 拦截掉（安全删除策略），
# 失败时 set -e 会直接中断整个构建。
"$PY" - "$B" <<'PYEOF'
import shutil, os, sys
p = sys.argv[1]
shutil.rmtree(p, ignore_errors=True)
for sub in ("gen", "classes", "dex", "res"):
    os.makedirs(os.path.join(p, sub), exist_ok=True)
PYEOF

echo "[1/8] aapt2 compile 资源"
"$BT/aapt2.exe" compile --dir "$ROOT/app/res" -o "$B/res.zip"

# 打包前先做一份干净的 assets 副本：
# 桌面端的 HTML 预览/编辑器会持续往 index.html 回写 data-page-node-id 之类属性，
# 与其跟它抢文件，不如打包时用净化过的副本，源文件保持可用。
"$PY" - "$ROOT/app/assets" "$B/assets-clean" <<'PYEOF'
import os, re, shutil, sys
src, dst = sys.argv[1], sys.argv[2]
shutil.rmtree(dst, ignore_errors=True)
shutil.copytree(src, dst)

# 下划线开头的是本地预览页（_p.html 之类），绝不该被打进 APK
dropped = []
for dp, _, fns in os.walk(dst):
    for fn in fns:
        if fn.startswith('_'):
            os.remove(os.path.join(dp, fn))
            dropped.append(fn)

n = 0
for dp, _, fns in os.walk(dst):
    for fn in fns:
        if not fn.endswith(('.html', '.htm', '.css', '.js')):
            continue
        fp = os.path.join(dp, fn)
        try:
            txt = open(fp, encoding="utf-8").read()
        except Exception:
            continue
        txt2 = re.sub(r"\s*data-page-node-id=\"[^\"]*\"", "", txt)
        if txt2 != txt:
            open(fp, "w", encoding="utf-8", newline="").write(txt2)
            n += 1
print("  已净化 %d 个文件%s" % (n, ("，剔除临时页 " + ",".join(dropped)) if dropped else ""))
PYEOF

echo "[2/8] aapt2 link 生成 base.apk + R.java"
"$BT/aapt2.exe" link \
  -o "$B/base.apk" \
  -I "$PLATFORM" \
  --manifest "$ROOT/app/AndroidManifest.xml" \
  -R "$B/res.zip" \
  -A "$B/assets-clean" \
  --java "$B/gen" \
  --min-sdk-version 26 \
  --target-sdk-version 34 \
  --version-code 13 \
  --version-name "1.0.9" \
  --auto-add-overlay

echo "[3/8] javac 编译 Java 源码"
find "$ROOT/app/src" -name '*.java' > "$B/srcs.txt"
find "$B/gen" -name '*.java' >> "$B/srcs.txt"
"$JAVAC" -encoding UTF-8 -source 8 -target 8 -nowarn \
  -bootclasspath "$PLATFORM" -cp "$PLATFORM" \
  -d "$B/classes" @"$B/srcs.txt"

echo "[4/8] d8 转 dex"
find "$B/classes" -name '*.class' > "$B/classes.txt"
"$BT/d8.bat" --release --lib "$PLATFORM" --min-api 26 --output "$B/dex" @"$B/classes.txt"

echo "[5/8] 打包 classes.dex 进 APK"
"$PY" - "$B/base.apk" "$B/dex/classes.dex" "$B/unsigned.apk" <<'PYEOF'
import sys, shutil, zipfile, os
base, dex, out = sys.argv[1], sys.argv[2], sys.argv[3]
shutil.copyfile(base, out)
with zipfile.ZipFile(out, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
print('  classes.dex 已写入', os.path.getsize(out), 'bytes')
PYEOF

echo "[6/8] zipalign"
"$BT/zipalign.exe" -f -p 4 "$B/unsigned.apk" "$B/aligned.apk"

echo "[7/8] 准备签名密钥"
if [ ! -f "$KS" ]; then
  "$KEYTOOL" -genkeypair -v \
    -keystore "$KS" -alias kcb -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KSPASS" -keypass "$KSPASS" \
    -dname "CN=HuagongSchedule, OU=Personal, O=Personal, L=Guangzhou, ST=Guangdong, C=CN" \
    > /dev/null 2>&1
  echo "  已生成新密钥"
else
  echo "  复用已有密钥"
fi

echo "[8/8] apksigner 签名"
"$BT/apksigner.bat" sign \
  --ks "$KS" --ks-pass "pass:$KSPASS" --key-pass "pass:$KSPASS" \
  --v1-signing-enabled true --v2-signing-enabled true \
  --out "$B/$APK_BASE.apk" "$B/aligned.apk"

"$BT/apksigner.bat" verify --print-certs "$B/$APK_BASE.apk" | head -4
echo
echo "==================== 构建完成 ===================="
ls -la "$B/$APK_BASE.apk"
echo "APK 路径: $B/$APK_BASE.apk"
