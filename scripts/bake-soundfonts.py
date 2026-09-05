# 从 .sfdist-tmp 解压 Arachno(zip)/Salamander(tar.xz)，提取 .sf2 放入 soundfonts-dist/<id>/
import os, shutil, tarfile, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TMP = os.path.join(ROOT, '.sfdist-tmp')
DIST = os.path.join(ROOT, 'soundfonts-dist')

def find_sf2(base):
    out = []
    for root_p, _, files in os.walk(base):
        for f in files:
            if f.lower().endswith(('.sf2', '.sf3')):
                out.append(os.path.join(root_p, f))
    return out

def place(src_sf2, dest_id):
    d = os.path.join(DIST, dest_id)
    os.makedirs(d, exist_ok=True)
    name = os.path.basename(src_sf2)
    dst = os.path.join(d, name)
    shutil.copy2(src_sf2, dst)
    print(f'[bake] {dest_id}/{name} ({os.path.getsize(dst)} bytes)')

if os.path.exists(os.path.join(TMP, 'arachno.zip')):
    zt = os.path.join(TMP, 'arachno_x')
    if os.path.exists(zt): shutil.rmtree(zt)
    os.makedirs(zt)
    with zipfile.ZipFile(os.path.join(TMP, 'arachno.zip')) as z:
        z.extractall(zt)
    for sf in find_sf2(zt):
        place(sf, 'arachno')

if os.path.exists(os.path.join(TMP, 'salamander.tar.xz')):
    st = os.path.join(TMP, 'salamander_x')
    if os.path.exists(st): shutil.rmtree(st)
    os.makedirs(st)
    with tarfile.open(os.path.join(TMP, 'salamander.tar.xz'), 'r:xz') as t:
        t.extractall(st)
    for sf in find_sf2(st):
        place(sf, 'salamander')

print('done')