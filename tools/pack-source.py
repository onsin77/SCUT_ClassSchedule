"""打包源码 zip。

注意：桌面端的 HTML 预览/编辑器会持续往 index.html 回写 data-page-node-id 属性，
所以在**写入 zip 的同时**做净化，保证包里的内容是干净的，而不是去改磁盘上的源文件
（改了也会被立刻覆盖）。
"""
import os
import re
import sys
import zipfile

# 项目根目录由脚本位置推出来，这样在哪个目录下调用都行
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = ROOT
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(ROOT), '华工课程表-源码.zip')
SKIP_DIRS = {'build', '.git', '__pycache__'}
SKIP_EXT = {'.class'}
STRIP = re.compile(r'\s*data-page-node-id="[^"]*"')
TEXT_EXT = {'.html', '.htm', '.css', '.js', '.md', '.xml', '.sh', '.java'}
ARC = os.path.basename(ROOT)          # zip 内的顶层目录名

count = 0
stripped = 0
with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
    for dp, dns, fns in os.walk(SRC):
        dns[:] = [d for d in dns if d not in SKIP_DIRS]
        for fn in sorted(fns):
            path = os.path.join(dp, fn)
            if os.path.splitext(fn)[1] in SKIP_EXT:
                continue
            arcname = os.path.join(ARC, os.path.relpath(path, SRC))
            ext = os.path.splitext(fn)[1].lower()
            if ext in TEXT_EXT:
                data = open(path, encoding='utf-8').read()
                cleaned = STRIP.sub('', data)
                if cleaned != data:
                    stripped += 1
                z.writestr(arcname, cleaned.encode('utf-8'))
            else:
                z.write(path, arcname)
            count += 1

print('打包 %d 个文件 -> %s (%.0f KB)，其中 %d 个文件做了净化'
      % (count, OUT, os.path.getsize(OUT) / 1024.0, stripped))
