import json, os, sys, urllib.request, zipfile, hashlib
ROOT=sys.argv[1]; DEST=os.path.join(ROOT,"models","miros"); os.makedirs(DEST,exist_ok=True)
base="https://cnb.cool/FuFuCloud-mirror/Models/-/releases/download/miros-v1/miros-runtime-20261021."
names=["z01","z02","z03","z04","z05","z06"]; pdir=os.path.join(DEST,".parts"); os.makedirs(pdir,exist_ok=True)
try:
 for n in names:
  p=os.path.join(pdir,"miros-runtime-20261021."+n)
  if os.path.exists(p) and os.path.getsize(p)>0: continue
  req=urllib.request.Request(base+n,headers={"User-Agent":"FuFumidi"})
  with urllib.request.urlopen(req,timeout=120) as r,open(p,"wb") as f:
   while True:
    b=r.read(1<<20)
    if not b: break
    f.write(b)
 zip_path=os.path.join(DEST,"miros.zip")
 with open(zip_path,"wb") as w:
  for n in names:
   with open(os.path.join(pdir,"miros-runtime-20261021."+n),"rb") as r:
    while True:
     b=r.read(1<<20)
     if not b: break
     w.write(b)
 with zipfile.ZipFile(zip_path) as z: z.extractall(DEST)
 os.remove(zip_path)
 for n in names:
  try: os.remove(os.path.join(pdir,"miros-runtime-20261021."+n))
  except OSError: pass
 print(json.dumps({"ok":True,"id":"miros","path":DEST}))
except Exception as e: print(json.dumps({"ok":False,"error":str(e)}))
