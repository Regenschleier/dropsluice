import json
import qrcode
from qrcode.constants import ERROR_CORRECT_M
from qrcode.util import QRData, MODE_8BIT_BYTE

data = json.load(open('qr-all.json', encoding='utf-8'))
total_bad = 0
for item in data:
    raw = item['text'].encode('utf-8')
    ok = 0
    for mask in range(8):
        qr = qrcode.QRCode(version=None, error_correction=ERROR_CORRECT_M, box_size=1, border=0, mask_pattern=mask)
        qr.add_data(QRData(raw, mode=MODE_8BIT_BYTE))
        qr.make(fit=True)
        ref = [''.join(str(int(v)) for v in row) for row in qr.modules]
        if ref == item['perMask'][mask] and len(ref) == len(item['perMask'][mask]):
            ok += 1
    total_bad += 8 - ok
    print(f"bytes={item['bytes']:3d} v{item['version']:2d}: {ok}/8 masks identical")
print('total mask mismatches =', total_bad)
