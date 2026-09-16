p = 'app/AndroidManifest.xml'
s = open(p, encoding='utf-8', newline='').read()
old = 'android:versionCode="8"'
assert old in s, '未找到 ' + old
open(p, 'w', encoding='utf-8', newline='').write(s.replace(old, 'android:versionCode="9"'))

p = 'tools/build.sh'
s = open(p, encoding='utf-8', newline='').read()
old = '--version-code 8'
assert old in s, '未找到 ' + old
open(p, 'w', encoding='utf-8', newline='').write(s.replace(old, '--version-code 9'))

print('versionCode 8 -> 9')
