"""Export one Markdown AIBOM per model from the v_model_aibom view (sql/005_aibom_views.sql).

Each section is one area table and each row one design field (column), so the document mirrors
AIBOM_스키마_설계안.md §2-3.

Usage:
    backend/.venv/Scripts/python scripts/aibom/export_model_md.py [docs/aibom-models]
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from load_research import ROOT, connect  # noqa: E402


def load(value):
    if value is None:
        return None
    return json.loads(value) if isinstance(value, (str, bytes)) else value


def cell(value) -> str:
    if value in (None, '', [], {}):
        return '–'
    if isinstance(value, list):
        value = ', '.join(cell(v) for v in value)
    elif isinstance(value, dict):
        value = ', '.join(f'{k}={cell(v)}' for k, v in value.items() if v not in (None, '', [], {}))
    return str(value).replace('|', '\\|').replace('\n', ' ')


def num(value) -> str:
    return '–' if value is None else f'{float(value):,.4f}'.rstrip('0').rstrip('.')


def link(title, uri) -> str:
    return f'[{cell(title or uri)}]({uri})' if uri else cell(title)


def short(revision):
    """Shorten git shas only; keep other revision labels (arXiv versions, config names) intact."""
    return revision[:12] if revision and re.fullmatch(r'[0-9a-f]{13,64}', revision) else revision


def file_name(model_id: str) -> str:
    return model_id.replace('/', '__') + '.md'


def field_table(rows) -> list[str]:
    out = ['| 필드 (컬럼) | 값 |', '|---|---|']
    out += [f'| `{name}` | {value if isinstance(value, str) and value.startswith(("[", "–")) else cell(value)} |'
            for name, value in rows]
    return out + ['']


def items(entries) -> str:
    if not entries:
        return '–'
    return '<br>'.join(f'• {cell(e.get("description"))}' + (f' ([source]({e["reference"]}))' if e.get('reference') else '')
                       for e in entries)


def render(row: dict) -> str:
    m = load(row['model']) or {}
    pv = load(row['provenance']) or {}
    tr = load(row['transformation']) or {}
    datasets = load(row['datasets']) or []
    evals = load(row['evaluation']) or []
    safety = load(row['safety_ethics']) or {}
    licenses = load(row['license_policy']) or []
    refs = load(row['reference']) or []
    ref_by_id = {r['id']: r for r in refs}
    catalog = m.get('catalog') or {}
    mx, px, tx = m.get('extensions') or {}, pv.get('extensions') or {}, tr.get('extensions') or {}

    out = [f'# {row["model_id"]}', '',
           f'> family `{row["family_key"]}` · role `{row["model_role"]}` · revision `{catalog.get("revision") or "–"}` · '
           f'[Hugging Face]({catalog.get("model_url")})  ',
           '> 테이블 = 설계안의 영역, 행 = 필드(컬럼). 자동 생성: `scripts/aibom/export_model_md.py`', '']

    out += ['## MODEL (`model`)', '']
    out += field_table([
        ('identity', m.get('identity')), ('architecture', m.get('architecture')), ('tokenizer', m.get('tokenizer')),
        ('modality', m.get('modality')), ('intended_use', m.get('intended_use')),
        ('capabilities', m.get('capabilities')), ('limitations', m.get('limitations')),
        ('provenance', f'→ provenance #{m["provenance"]}' if m.get('provenance') else None),
        ('extensions', {k: v for k, v in mx.items() if k not in ('unknowns', 'evidence')})])

    out += ['## PROVENANCE (`provenance`)', '']
    out += field_table([
        ('subject', pv.get('subject')), ('origin', pv.get('origin')), ('provider', pv.get('provider')),
        ('parent', pv.get('parent') or '– (root)'), ('relation', pv.get('relation')),
        ('evidence', '[' + ', '.join(link(f'#{i}', ref_by_id.get(i, {}).get('uri')) for i in pv.get('evidence') or [])
         + ']' if pv.get('evidence') else None),
        ('extensions', px)])

    out += ['## TRANSFORMATION (`transformation`)', '']
    inputs = tr.get('input') or []
    out += field_table([
        ('input', '[' + ', '.join(
            (f'{i["model"]} (external)' if i.get('external') else f'[{i["model"]}]({file_name(i["model"])})')
            + f' · {i["role"]}' for i in inputs) + ']' if inputs else None),
        ('output', tr.get('output')),
        ('method', ' → '.join(tr.get('method') or []) or None), ('objective', tr.get('objective')),
        ('hyperparameters', tr.get('hyperparameters')),
        ('datasets', [f'{d["dataset"]} ({d["role"]})' for d in tr.get('datasets') or []]),
        ('timestamp', tr.get('timestamp')), ('extensions', {'notes': tx.get('notes')})])

    out += ['## DATASET (`dataset`)', '']
    if datasets:
        out += ['| identity | version | role | license | processing | provenance (parent · relation · disclosure) |',
                '|---|---|---|---|---|---|']
        for d in sorted(datasets, key=lambda d: d['identity']):
            ext = d.get('extensions') or {}
            out.append(f'| {link(ext.get("name") or d["identity"], ext.get("uri"))}<br>`{d["identity"]}` | '
                       f'{cell(short(d.get("version")))} | {cell(d.get("role"))} | {cell(d.get("license"))} | '
                       f'{cell(d.get("processing"))} | {cell(d.get("parent"))} · {cell(d.get("relation"))} · '
                       f'{cell(d.get("disclosure_status"))} |')
    else:
        out.append('– (연결된 학습·평가 데이터셋 없음)')
    out.append('')

    out += ['## EVALUATION (`evaluation`)', '']
    if evals:
        out += ['| configuration.benchmark | dataset | metric | score | timestamp | baseline (Δ) | source |',
                '|---|---|---|---|---|---|---|']
        for e in sorted(evals, key=lambda e: ((e.get('configuration') or {}).get('benchmark') or '', e.get('metric') or '')):
            conf, ext = dict(e.get('configuration') or {}), e.get('extensions') or {}
            benchmark = conf.pop('benchmark', None)
            score = num(e.get('score')) if e.get('score') is not None else cell(ext.get('score_text'))
            base = ext.get('baseline_score')
            baseline = '–'
            if base is not None:
                delta = (float(e['score']) - float(base)) if e.get('score') is not None else None
                baseline = f'{num(base)} ({"+" if delta and delta > 0 else ""}{num(delta)})' if delta is not None else num(base)
            config_note = cell({k: v for k, v in conf.items() if k != 'notes'})
            out.append(f'| {cell(benchmark)}{"<br><sub>" + config_note + "</sub>" if config_note != "–" else ""} | '
                       f'{cell(e.get("dataset"))} | {cell(e.get("metric"))} | {score} | {cell(e.get("timestamp"))} | '
                       f'{baseline} | {link("source", ext.get("reference"))} |')
        bases = sorted({(e.get('extensions') or {}).get('baseline_model') for e in evals} - {None})
        if bases:
            out += ['', f'baseline 모델: {", ".join(f"`{b}`" for b in bases)}']
    else:
        out.append('– (이 모델 자체의 평가 결과가 보고되지 않음)')
    out.append('')

    out += ['## SAFETY_ETHICS (`safety_ethics`)', '']
    out += field_table([
        ('safety_risk', items(safety.get('safety_risk'))),
        ('ethical_considerations', items(safety.get('ethical_considerations'))),
        ('prohibited_use', items(safety.get('prohibited_use'))), ('mitigation', items(safety.get('mitigation'))),
        ('extensions', safety.get('extensions'))])

    out += ['## LICENSE_POLICY (`license_policy`)', '']
    if licenses:
        out += ['| subject | license | usage_policy | restrictions | extensions |', '|---|---|---|---|---|']
        for lic in licenses:
            ext = lic.get('extensions') or {}
            out.append(f'| {cell(lic["subject"])} | {link(lic["license"], ext.get("license_uri"))} | '
                       f'{link(lic.get("usage_policy"), ext.get("usage_policy_uri")) if lic.get("usage_policy") else "–"} | '
                       f'{cell(lic.get("restrictions"))} | '
                       f'{cell({k: ext.get(k) for k in ("spdx_id", "kind", "commercial_use", "scope_note")})} |')
    else:
        out.append('–')
    out.append('')

    out += ['## REFERENCE (`reference`)', '', '| id | type | uri | revision | retrieved_at | hash |', '|---|---|---|---|---|---|']
    for r in sorted(refs, key=lambda r: r['id']):
        ext = r.get('extensions') or {}
        out.append(f'| {r["id"]} | {r["type"]} | {link(ext.get("title"), r["uri"])} | '
                   f'{cell(short(r.get("revision")))} | {cell(r.get("retrieved_at"))} | '
                   f'{"`" + r["hash"][:12] + "…`" if r.get("hash") else "–"} |')
    out.append('')

    if mx.get('unknowns'):
        out += ['## 확인되지 않은 정보 (`model.extensions.unknowns`)', ''] + [f'- {u}' for u in mx['unknowns']] + ['']
    return '\n'.join(out)


def main():
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'docs' / 'aibom-models'
    out_dir.mkdir(parents=True, exist_ok=True)
    conn = connect()
    cur = conn.cursor()
    cur.execute("SELECT * FROM v_model_aibom ORDER BY family_key, FIELD(model_role, 'BASE', 'INSTRUCT', 'DERIVED'), model_id")
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    counts = {}
    for table in ('model', 'dataset', 'transformation', 'evaluation', 'provenance', 'safety_ethics', 'license_policy',
                  'reference'):
        cur.execute(f'SELECT COUNT(*) FROM `{table}`')
        counts[table] = cur.fetchone()[0]
    conn.close()

    index = ['# 모델별 AIBOM', '',
             '`v_model_aibom` view에서 자동 생성한 문서입니다. 다시 만들려면 '
             '`backend/.venv/Scripts/python scripts/aibom/export_model_md.py`를 실행하세요.', '',
             '테이블별 행 수: ' + ' · '.join(f'`{t}` {n}' for t, n in counts.items()), '',
             '| model | family | role | relation | input | method | evaluation | safety | license |',
             '|---|---|---|---|---|---|---|---|---|']
    for row in rows:
        (out_dir / file_name(row['model_id'])).write_text(render(row), encoding='utf-8')
        pv = load(row['provenance']) or {}
        tr = load(row['transformation']) or {}
        safety = load(row['safety_ethics']) or {}
        n_safety = sum(len(safety.get(k) or []) for k in ('safety_risk', 'ethical_considerations', 'prohibited_use',
                                                          'mitigation'))
        inputs = [f'{i["model"]}{"*" if i.get("external") else ""} ({i["role"]})' for i in tr.get('input') or []]
        licenses = [lic['license'] for lic in load(row['license_policy']) or []]
        index.append(f'| [{row["model_id"]}]({file_name(row["model_id"])}) | {row["family_key"]} | {row["model_role"]} | '
                     f'{cell(pv.get("relation"))} | {cell(inputs)} | {len(tr.get("method") or [])} steps | '
                     f'{len(load(row["evaluation"]) or [])} | {n_safety} | {cell(licenses)} |')
    index += ['', '`*` 카탈로그 밖의 외부 모델 (예: GPT-4o를 generator/verifier로 사용)', '']
    (out_dir / 'README.md').write_text('\n'.join(index), encoding='utf-8')
    print(f'wrote {len(rows) + 1} files to {out_dir}')


if __name__ == '__main__':
    main()
