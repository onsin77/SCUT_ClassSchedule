#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""改版本号。

    python tools/bump-version.py 1.1.2

一次把版本号出现在的地方全改掉，省得每发一版手写一堆替换脚本：

    app/AndroidManifest.xml     versionCode 自增 1、versionName
    tools/build.sh              --version-code、--version-name
    app/assets/www/app.js       数据库里的 version、帮助页标题
    app/assets/www/index.html   设置页底部的署名
    README.md                   标题、APK 文件名

每一项都是「找不到就跳过」，所以重复执行不会出错、也不会改坏东西。
改完还会提醒你 README 的更新日志要补、以及怎么出包。
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8', newline='') as f:
        return f.read()


def write(rel, s):
    with open(os.path.join(ROOT, rel), 'w', encoding='utf-8', newline='') as f:
        f.write(s)


def current():
    """从清单里读出当前的 versionCode / versionName"""
    s = read('app/AndroidManifest.xml')
    code = re.search(r'android:versionCode="(\d+)"', s)
    name = re.search(r'android:versionName="([^"]+)"', s)
    if not code or not name:
        sys.exit('读不出 AndroidManifest.xml 里的版本号')
    return int(code.group(1)), name.group(1)


def sub(rel, pairs, log):
    """在某个文件里做若干次替换；没命中的会记进 log"""
    try:
        s = read(rel)
    except FileNotFoundError:
        log.append('%s：文件不存在，跳过' % rel)
        return
    orig = s
    for old, new in pairs:
        if old in s:
            s = s.replace(old, new)
        else:
            log.append('%s：没找到 %r' % (rel, old))
    if s != orig:
        write(rel, s)
        print('  ✔ %s' % rel)
    else:
        print('  – %s（无需修改）' % rel)


def main():
    if len(sys.argv) != 2 or not re.fullmatch(r'\d+(\.\d+){1,3}', sys.argv[1]):
        sys.exit(__doc__)
    new_name = sys.argv[1]
    old_code, old_name = current()
    new_code = old_code + 1

    if old_name == new_name:
        sys.exit('版本号没变（还是 %s）' % new_name)

    print('%s (%d)  →  %s (%d)\n' % (old_name, old_code, new_name, new_code))
    log = []

    sub('app/AndroidManifest.xml', [
        ('android:versionCode="%d"' % old_code, 'android:versionCode="%d"' % new_code),
        ('android:versionName="%s"' % old_name, 'android:versionName="%s"' % new_name),
    ], log)

    sub('tools/build.sh', [
        ('--version-code %d' % old_code, '--version-code %d' % new_code),
        ('--version-name "%s"' % old_name, '--version-name "%s"' % new_name),
    ], log)

    sub('app/assets/www/app.js', [
        ("version: '%s'" % old_name, "version: '%s'" % new_name),
        ('华工课程表 v%s · ' % old_name, '华工课程表 v%s · ' % new_name),
    ], log)

    sub('app/assets/www/index.html', [
        ('华工课程表 v%s · ' % old_name, '华工课程表 v%s · ' % new_name),
    ], log)

    sub('README.md', [
        # 标题有意不带版本号，所以只改 APK 文件名那一处
        ('`华工课程表-v%s.apk`' % old_name, '`华工课程表-v%s.apk`' % new_name),
    ], log)

    # 复核清单，这是最要紧的一处
    s = read('app/AndroidManifest.xml')
    assert 'android:versionCode="%d"' % new_code in s, '清单里 versionCode 没改成功'
    assert 'android:versionName="%s"' % new_name in s, '清单里 versionName 没改成功'

    if log:
        print('\n以下地方没命中，自己看一眼是不是已经改过了：')
        for line in log:
            print('  ! ' + line)

    print('\n搞定。别忘了：')
    print('  1. 在 README.md 的「更新日志」加一节 v%s' % new_name)
    print('  2. bash tools/build.sh')
    print('  3. python tools/pack-source.py 华工课程表-v%s-源码.zip' % new_name)


if __name__ == '__main__':
    main()
