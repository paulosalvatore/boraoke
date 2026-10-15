import json,sys
f=sys.argv[1]; d=json.load(open(f))
keys=sorted({k.rsplit('|',1)[0] for k in d})
for base in keys:
  pr=d[base+'|pr']['els']; pd=d[base+'|prod']['els']
  print('==',base, 'missing in pr:',[k.split('>')[-1] for k in pd if k not in pr][:5])
  for k in pd:
    if k not in pr: continue
    a,b=pd[k],pr[k]
    dl=[round(b[i]-a[i],2) for i in range(4)]
    if any(abs(x)>1 for x in dl):
      print('  ',' > '.join(k.split('>')[-2:]), 'prod',a,'d',dl)
