import json,sys
c,S=sys.argv[1],sys.argv[2]
r=json.load(open(f"{S}/review_{c}.json")); p=json.load(open(f"plans/{c}/plan.json"))
el={a["area"]:a["level"] for a in p["riskAssessment"]}
agree=0
for a in r["areas"]:
    e=el.get(a["area"]); same=e==a["level"]; agree+=same
    print(f'{"  " if same else "≠ "}{a["area"]:28} engine={e:14} review={a["level"]:14} ({a["confidence"]})')
print(f"agreement {agree}/{len(r['areas'])}")
sel={x["procedureId"] for x in p["procedures"] if x["selected"]}
must={x["procedureId"] for x in r["mustSelect"]}; omit={x["procedureId"] for x in r["shouldOmit"]}
print("review selects, engine does not:", sorted(must-sel)); print("engine selects, review omits:", sorted(sel&omit))
print("engine hours", p["totalHours"], "/", p["budgetHours"])
