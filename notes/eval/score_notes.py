import json,sys
S=sys.argv[1]
ext=json.load(open(f"{S}/extracted.json")); gold=json.load(open(f"{S}/notes_gold.json"))
def prf(pred,g):
    tp=len(pred&g); p=tp/len(pred) if pred else 1; r=tp/len(g) if g else 1
    return tp,p,r,(2*p*r/(p+r) if p+r else 0)
tot={}
rows=[]
for c,v in ext.items():
    G={f"{n}|{l['area']}|{l['direction']}" for n,ls in gold[c].items() for l in ls}
    Gh={f"{n}|{l['area']}|{l['direction']}" for n,ls in gold[c].items() for l in ls if l["confidence"]=="high"}
    sets={"merged":set(v["merged"])}|{f"run{i+1} {r['model']}":set(r["claims"]) for i,r in enumerate(v["runs"])}
    for name,P in sets.items():
        t=tot.setdefault(name,[0,0,0,0,0]); tp=len(P&G); t[0]+=tp; t[1]+=len(P); t[2]+=len(G); t[3]+=len(P&Gh); t[4]+=len(Gh)
    m=sets["merged"]
    rows.append((c,sorted(m-G),sorted(G-m)))
print(f"{'':30} precision recall  F1   recall(high-conf gold)")
for name,(tp,np_,ng,tph,ngh) in tot.items():
    p=tp/np_; r=tp/ng; print(f"{name:30} {p:8.2f} {r:6.2f} {2*p*r/(p+r):5.2f} {tph/ngh:8.2f}   (tp {tp}, pred {np_}, gold {ng})")
for c,fp,fn in rows:
    print(f"\n== {c}\n  extracted, not in gold: {fp}\n  gold, not extracted:   {fn}")
