"""把若干文件打成一个 zip（只存不压？不，这里用 deflate 9，但保留 UTF-8 文件名标志）。

为什么不用 Compress-Archive / 7z：
  - PowerShell 的 Compress-Archive 在旧版本里会把中文名写成 GBK，手机解压出来是乱码；
  - 7z 不在每台机器上。
python 的 zipfile 支持给条目设 UTF-8 标志（自动在需要时置位），跨机器都能正确解出中文名。

用法：python scripts/make-zip.py <输出.zip> <文件1> [文件2 …]
"""
import sys
import os
import zipfile

if len(sys.argv) < 3:
    print('用法：python scripts/make-zip.py <输出.zip> <文件1> [文件2 …]')
    raise SystemExit(2)

out = sys.argv[1]
files = sys.argv[2:]

missing = [f for f in files if not os.path.isfile(f)]
if missing:
    print('缺文件：' + '、'.join(missing))
    raise SystemExit(1)

os.makedirs(os.path.dirname(os.path.abspath(out)) or '.', exist_ok=True)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for f in files:
        # arcname 用文件名本身：解压后是一个平铺的文件夹内容
        z.write(f, os.path.basename(f))

with zipfile.ZipFile(out) as z:
    names = z.namelist()
    bad = z.testzip()

print(f'已写入 {out}：{len(names)} 个条目，{os.path.getsize(out)} 字节')
for n in names:
    print('  ' + n)
if bad:
    print('校验失败：' + bad)
    raise SystemExit(1)
