import json,sys
S=sys.argv[1]; plan=json.load(open(sys.argv[2]))
r1={a["area"]:a for a in json.load(open(f"{S}/review_wetherby.json"))["areas"]}
r2={a["area"]:a for a in json.load(open(f"{S}/review2_wetherby.json"))["areas"]}
eng={a["area"]:a["level"] for a in plan["riskAssessment"]}
n=len(eng); k12=k1e=k2e=0
for a in eng:
    l1,l2,e=r1[a]["level"],r2[a]["level"],eng[a]; k12+=l1==l2; k1e+=l1==e; k2e+=l2==e
    print(f"{a:28} R1={l1:14} R2={l2:14} engine={e:14} {'' if l1==l2 else '  reviewers differ'}")
print(f"R1~R2 {k12}/{n}   R1~engine {k1e}/{n}   R2~engine {k2e}/{n}")
