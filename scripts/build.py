import pandas as pd, json, os, glob, base64
from datetime import datetime

def col(l):
    l=l.upper(); r=0
    for c in l: r=r*26+(ord(c)-64)
    return r-1

def find_excel():
    for p in ['data/Blufox_-_Sales_Report_*.xlsx','data/Blufox*.xlsx','data/*.xlsx']:
        f=glob.glob(p)
        if f: return max(f,key=os.path.getmtime)
    raise FileNotFoundError("No Excel file found in data/")

JEFF='Jeffrey Bilbrey'

def parse_stores(fp):
    df=pd.read_excel(fp,sheet_name='Store Rank',header=None).iloc[7:]
    df.columns=range(len(df.columns))
    rs=[]
    for _,r in df[df[4]==JEFF].iterrows():
        d=str(r[5]); dm='None'
        if 'Fear' in d: dm='Fear'
        elif 'Cabrales' in d: dm='Cabrales'
        elif 'Brooks' in d: dm='Brooks'
        def v(c,digs=4):
            try: return round(float(r[c] or 0),digs)
            except: return 0
        rs.append({
            'rank':int(r[0]) if pd.notna(r[0]) else 0,
            's':str(r[2]),'dm':dm,
            'gp_trend':v(col('M'),2),'mcr':v(col('V')),'fcr':v(col('X')),
            'nt':v(col('AB')),'gig':v(col('BJ')),
            'mob':int(v(col('BL'),0)),'tab':int(v(col('BM'),0)),'watch':int(v(col('BN'),0)),
            'prem':v(col('BT')),'n2u':v(col('BY')),'apd':v(col('CJ'),2),
            'nps':v(col('CM')),'sc':v(112,1),'gp':v(7,2)
        })
    return rs

def parse_reps(fp,ss):
    df=pd.read_excel(fp,sheet_name='Rep Rank',header=None).iloc[5:]
    df.columns=range(len(df.columns))
    bs={}
    for _,r in df[df[3].isin(ss)].iterrows():
        st=str(r[3])
        if st not in bs: bs[st]=[]
        def v(c,d=4):
            try: return round(float(r[c] or 0),d)
            except: return 0
        bs[st].append({
            'natrank':int(v(col('A'),0)),'name':str(r[col('B')]),'store':st,
            'gp':v(col('G'),2),'gig':v(col('L')),'prem':v(col('U')),'acc':v(col('AD'),2)
        })
    for st in bs: bs[st].sort(key=lambda x:-x['gp'])
    return bs

def main():
    print("Cook County Cooks - Daily Sales Board Builder")
    fp=find_excel()
    print(f"  Using: {fp}")
    stores=parse_stores(fp)
    print(f"  Stores: {len(stores)}")
    store_set={s['s'] for s in stores}
    reps=parse_reps(fp,store_set)
    print(f"  Reps: {sum(len(v) for v in reps.values())}")
    logo_path='scripts/logo.b64'
    logo=open(logo_path).read().strip() if os.path.exists(logo_path) else ''
    tmpl=open('scripts/template.html').read()
    date=datetime.now().strftime('%B %d, %Y')
    html=tmpl.replace('LOGO_SRC',logo).replace('SD_PLACEHOLDER',json.dumps(stores)).replace('RD_PLACEHOLDER',json.dumps(reps)).replace('REPORT_DATE',date)
    with open('index.html','w') as f: f.write(html)
    print(f"  Done: index.html ({len(html):,} bytes)")

if __name__=='__main__': main()
