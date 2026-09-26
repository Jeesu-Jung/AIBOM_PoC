"""Collect machine-verifiable facts for the research JSON, in parallel.

- REFERENCE.hash          SHA-256 of each reference URI's content as fetched now
- REFERENCE published_at  source publication date (arXiv version date, HF / GitHub commit date)
                          -> used as EVALUATION.timestamp ("when the result was reported")
- DATASET.version/license HF dataset revision sha and declared license

Usage:
    backend/.venv/Scripts/python scripts/aibom/enrich_research.py [data/aibom_research]
Writes <dir>/_enrichment.json, which load_research.py merges in.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
UA = {'User-Agent': 'AIBOM-PoC research enrichment (contact: repo owner)'}
MONTHS = {m: i for i, m in enumerate(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct',
                                      'Nov', 'Dec'], 1)}


def get(client, url, **kw):
    try:
        return client.get(url, headers=UA, follow_redirects=True, timeout=40, **kw)
    except httpx.HTTPError:
        return None


def iso_date(value):
    return value[:10] if value else None


def arxiv_date(client, arxiv_id, version):
    r = get(client, f'https://arxiv.org/abs/{arxiv_id}')
    if not r or r.status_code != 200:
        return None, None
    history = re.findall(r'\[v(\d+)\]\s*</strong>.*?\w{3},\s+(\d{1,2})\s+(\w{3})\s+(\d{4})', r.text, re.S)
    if not history:
        return None, None
    by_version = {int(v): f'{y}-{MONTHS[m]:02d}-{int(d):02d}' for v, d, m, y in history}
    wanted = int(version) if version else max(by_version)
    return by_version.get(wanted), f'v{wanted}'


def hf_date(client, kind, repo, revision):
    base = f'https://huggingface.co/api/{kind}/{repo}'
    r = get(client, f'{base}/revision/{revision}' if revision else base)
    if not r or r.status_code != 200:
        return None, None
    data = r.json()
    return iso_date(data.get('lastModified')), data.get('sha')


def github_date(client, owner, repo, ref, path):
    r = get(client, f'https://api.github.com/repos/{owner}/{repo}/commits',
            params={'path': path, 'sha': ref, 'per_page': 1})
    if not r or r.status_code != 200 or not r.json():
        return None, None
    commit = r.json()[0]
    return iso_date(commit['commit']['committer']['date']), commit['sha']


def enrich_reference(ref):
    uri, revision = ref['uri'], ref.get('revision')
    out = {'uri': uri, 'fetched_at': datetime.now(timezone.utc).date().isoformat()}
    with httpx.Client() as client:
        r = get(client, uri)
        out['http_status'] = r.status_code if r else None
        if r is not None and r.status_code == 200:
            out['sha256'] = hashlib.sha256(r.content).hexdigest()
            if r.headers.get('last-modified'):
                out['last_modified_header'] = parsedate_to_datetime(r.headers['last-modified']).date().isoformat()
        published, resolved = None, None
        if m := re.search(r'arxiv\.org/(?:abs|pdf|html)/(\d{4}\.\d{4,5})(?:v(\d+))?', uri):
            version = m.group(2) or (re.sub(r'\D', '', revision) if revision and re.match(r'v?\d+$', revision) else None)
            published, resolved = arxiv_date(client, m.group(1), version)
        elif m := re.search(r'huggingface\.co/(?:api/(?:models/)?)?(datasets/)?([\w.-]+/[\w.-]+)', uri):
            sha = revision if revision and re.fullmatch(r'[0-9a-f]{7,40}', revision) else None
            published, resolved = hf_date(client, 'datasets' if m.group(1) else 'models', m.group(2), sha)
        elif m := re.search(r'raw\.githubusercontent\.com/([\w.-]+)/([\w.-]+)/([\w.-]+)/(.+)', uri):
            published, resolved = github_date(client, *m.groups())
        elif m := re.search(r'github\.com/([\w.-]+)/([\w.-]+)', uri):
            published, resolved = github_date(client, m.group(1), m.group(2), 'HEAD', '')
        out['published_at'] = published or out.get('last_modified_header')
        out['resolved_revision'] = resolved
    return out


def enrich_dataset(hf_id):
    with httpx.Client() as client:
        r = get(client, f'https://huggingface.co/api/datasets/{hf_id}')
        if not r or r.status_code != 200:
            return hf_id, {'http_status': r.status_code if r else None}
        data = r.json()
        license_ = (data.get('cardData') or {}).get('license')
        return hf_id, {'version': data.get('sha'), 'license': license_ if isinstance(license_, str) else
                       (', '.join(license_) if license_ else None), 'last_modified': iso_date(data.get('lastModified'))}


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'data' / 'aibom_research'
    docs = [json.loads(p.read_text(encoding='utf-8')) for p in sorted(src.glob('*.json')) if not p.name.startswith('_')]
    supplements = [ds for p in sorted(src.glob('_datasets_*.json'))
                   for ds in json.loads(p.read_text(encoding='utf-8')).get('datasets', {}).values()]
    refs = {r['uri']: r for d in docs for r in d['references'] if r.get('uri')}
    refs.update({ds['reference']['uri']: ds['reference'] for ds in supplements
                 if (ds.get('reference') or {}).get('uri') and ds['reference']['uri'] not in refs})
    datasets = sorted({ds['hf_id'] for d in docs for ds in d['datasets'] if ds.get('hf_id')}
                      | {ds['key'] for d in docs for ds in d['datasets'] if not ds['key'].startswith('slug:')}
                      | {e['dataset_key'] for d in docs for e in d['evaluations']
                         if e.get('dataset_key') and not e['dataset_key'].startswith('slug:')}
                      | {ds['hf_id'] for ds in supplements if ds.get('hf_id')})
    print(f'{len(refs)} references, {len(datasets)} HF datasets')
    with ThreadPoolExecutor(max_workers=12) as pool:
        ref_results = list(pool.map(enrich_reference, refs.values()))
        ds_results = dict(pool.map(enrich_dataset, datasets))
    out = {'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
           'references': {r['uri']: r for r in ref_results}, 'datasets': ds_results}
    (src / '_enrichment.json').write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
    ok = sum(1 for r in ref_results if r.get('sha256'))
    dated = sum(1 for r in ref_results if r.get('published_at'))
    print(f'hash {ok}/{len(ref_results)} · published_at {dated}/{len(ref_results)} · '
          f'datasets with version {sum(1 for d in ds_results.values() if d.get("version"))}/{len(ds_results)}')
    for r in ref_results:
        if not r.get('sha256') or not r.get('published_at'):
            print('  gap', r['http_status'], r.get('published_at'), r['uri'])


if __name__ == '__main__':
    main()
