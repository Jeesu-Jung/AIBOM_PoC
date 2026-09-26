"""Load per-model AIBOM research JSON into the area tables (sql/004_aibom_extended_schema.sql).

Usage:
    backend/.venv/Scripts/python scripts/aibom/load_research.py [data/aibom_research]

Inputs: <dir>/<org>__<name>.json (one per model) and <dir>/_enrichment.json
(scripts/aibom/enrich_research.py: reference hashes / publication dates, HF dataset revisions).
Connection: DATABASE_URL env var, else DATABASE_URL in backend/.env.local.
Re-runnable: rows owned by each loaded model are replaced; reference and dataset rows are upserted.
"""
from __future__ import annotations

import json
import os
import re
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import unquote, urlparse

import pymysql

ROOT = Path(__file__).resolve().parents[2]

REF_TYPES = {'paper', 'technical_report', 'model_card', 'dataset_card', 'repository', 'config',
             'documentation', 'license', 'blog', 'webpage'}
REF_TYPE_ALIASES = {'tech_report': 'technical_report', 'report': 'technical_report', 'arxiv': 'paper',
                    'github': 'repository', 'repo': 'repository', 'api': 'config', 'hf_api': 'config',
                    'policy': 'license', 'license_text': 'license', 'docs': 'documentation',
                    'model_repository': 'repository', 'dataset': 'dataset_card'}
DISCLOSURE = {'disclosed', 'partially_disclosed', 'undisclosed'}
INPUT_ROLES = {'base', 'merge_source', 'teacher', 'generator', 'verifier', 'reward_model'}
DATASET_ROLES = {'pretraining', 'finetuning', 'preference', 'distillation', 'calibration', 'other'}
SAFETY_FIELDS = {'risk': 'safety_risk', 'ethical_consideration': 'ethical_considerations',
                 'prohibited_use': 'prohibited_use', 'mitigation': 'mitigation'}
COMMERCIAL = {'allowed', 'restricted', 'prohibited', 'unknown'}
# transformation.datasets role -> dataset.role (the design's pretraining / finetuning / evaluation)
DATASET_ROLE_GROUP = {'pretraining': 'pretraining', 'finetuning': 'finetuning', 'preference': 'finetuning',
                      'distillation': 'finetuning', 'calibration': 'finetuning', 'other': 'finetuning'}
PARENT_ROLES = {'base', 'merge_source'}


def database_url() -> str:
    url = os.getenv('DATABASE_URL')
    if not url:
        env = ROOT / 'backend' / '.env.local'
        for line in env.read_text(encoding='utf-8').splitlines():
            if line.startswith('DATABASE_URL='):
                url = line.split('=', 1)[1].strip()
    if not url:
        sys.exit('DATABASE_URL is not set')
    return url


def connect():
    u = urlparse(database_url().replace('mysql+pymysql', 'mysql'))
    return pymysql.connect(host=u.hostname, port=u.port or 3306, user=unquote(u.username or ''),
                           password=unquote(u.password or ''), database=u.path.lstrip('/') or 'aibom',
                           charset='utf8mb4', autocommit=False)


def js(value):
    if isinstance(value, dict):
        value = {k: v for k, v in value.items() if v not in (None, '', [], {})}
    return None if value in (None, '', [], {}) else json.dumps(value, ensure_ascii=False)


def to_int(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    digits = re.sub(r'[^\d]', '', str(value))
    return int(digits) if digits else None


def to_decimal(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        d = Decimal(str(value).strip().rstrip('%'))
    except InvalidOperation:
        return None
    return d if abs(d) < Decimal('1e10') else None


def to_date(value):
    if not value:
        return None
    m = re.match(r'^(\d{4})-(\d{2})(?:-(\d{2}))?', str(value))
    return f'{m.group(1)}-{m.group(2)}-{m.group(3) or "01"}' if m else None


def pick(value, allowed, default):
    value = (value or '').strip().lower().replace(' ', '_').replace('-', '_')
    return value if value in allowed else default


class Loader:
    def __init__(self, conn, enrichment):
        self.conn = conn
        self.cur = conn.cursor()
        self.enrich_refs = enrichment.get('references', {})
        self.enrich_ds = enrichment.get('datasets', {})
        self.cur.execute('SELECT model_id FROM model_info')
        self.known_models = {r[0] for r in self.cur.fetchall()}
        self.stats = {}
        self.license_names: dict[str, str] = {}

    def canonicalize_licenses(self, docs):
        """One display name per license_key (the shortest one used), so LICENSE_POLICY.license is comparable."""
        for doc in docs:
            for lic in doc.get('licenses') or []:
                key, name = lic.get('license_key'), (lic.get('name') or '').strip()
                if key and name and (key not in self.license_names or len(name) < len(self.license_names[key])):
                    self.license_names[key] = name

    def bump(self, key, n=1):
        self.stats[key] = self.stats.get(key, 0) + n

    def execute(self, sql, params=()):
        self.cur.execute(sql, params)
        return self.cur.lastrowid

    def published_at(self, uri):
        return to_date((self.enrich_refs.get(uri) or {}).get('published_at'))

    # --- REFERENCE ---------------------------------------------------------------------------
    def upsert_reference(self, ref: dict) -> int | None:
        uri = (ref.get('uri') or '').strip()
        if not uri:
            return None
        ref_type = REF_TYPE_ALIASES.get((ref.get('type') or '').strip().lower(), (ref.get('type') or '').lower())
        ref_type = ref_type if ref_type in REF_TYPES else 'webpage'
        extra = self.enrich_refs.get(uri) or {}
        revision = ref.get('revision') or extra.get('resolved_revision')
        extensions = {'title': ref.get('title'), 'published_at': extra.get('published_at'),
                      'http_status': extra.get('http_status')}
        self.execute(
            """INSERT INTO reference (`type`, uri, revision, retrieved_at, `hash`, extensions)
               VALUES (%s, %s, %s, %s, %s, %s)
               ON DUPLICATE KEY UPDATE `type` = VALUES(`type`), revision = COALESCE(VALUES(revision), revision),
                 retrieved_at = VALUES(retrieved_at), `hash` = COALESCE(VALUES(`hash`), `hash`),
                 extensions = COALESCE(VALUES(extensions), extensions)""",
            (ref_type, uri, revision, to_date(extra.get('fetched_at') or ref.get('retrieved_at') or '2026-09-26'),
             extra.get('sha256'), js(extensions)))
        self.cur.execute('SELECT id FROM reference WHERE uri_hash = SHA2(%s, 256)', (uri,))
        return self.cur.fetchone()[0]

    # --- PROVENANCE --------------------------------------------------------------------------
    def replace_provenance(self, subject, origin, provider, parent, relation, evidence, extensions) -> int:
        self.execute('DELETE FROM provenance WHERE subject = %s', (subject,))
        self.bump('provenance')
        return self.execute(
            """INSERT INTO provenance (subject, origin, provider, parent, relation, evidence, extensions)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            (subject, origin, provider, js(parent), relation, js(sorted({e for e in evidence if e})), js(extensions)))

    # --- LICENSE_POLICY ----------------------------------------------------------------------
    def insert_license(self, subject, lic: dict, evidence_uri=None):
        name = self.license_names.get(lic.get('license_key')) or (lic.get('name') or lic.get('license_key') or '').strip()
        if not name:
            return
        extensions = {'license_key': lic.get('license_key'), 'spdx_id': lic.get('spdx_id'),
                      'license_uri': lic.get('uri'), 'usage_policy_uri': lic.get('usage_policy_uri'),
                      'kind': lic.get('kind'), 'scope_note': lic.get('scope_note'),
                      'commercial_use': pick(lic.get('commercial_use'), COMMERCIAL, None), 'source': evidence_uri}
        self.execute(
            """INSERT INTO license_policy (subject, license, usage_policy, restrictions, extensions)
               VALUES (%s, %s, %s, %s, %s)
               ON DUPLICATE KEY UPDATE usage_policy = COALESCE(VALUES(usage_policy), usage_policy),
                 restrictions = COALESCE(VALUES(restrictions), restrictions), extensions = VALUES(extensions)""",
            (subject, name[:200], lic.get('usage_policy_name'), js(lic.get('restrictions')), js(extensions)))
        self.bump('license_policy')

    # --- DATASET (merged across all documents) -----------------------------------------------
    def load_datasets(self, docs, supplements=None) -> dict[str, dict]:
        merged: dict[str, dict] = {}
        evidence: dict[str, set] = {}
        for doc in docs:
            refs = {r['key']: r for r in doc.get('references', []) if r.get('key')}
            for ds in doc.get('datasets') or []:
                key = ds.get('key')
                if not key:
                    continue
                cur = merged.setdefault(key, {})
                for field, value in ds.items():
                    if field in ('processing', 'parents', 'evidence'):
                        existing = cur.setdefault(field, [])
                        existing.extend(v for v in value or [] if v not in existing)
                    elif cur.get(field) in (None, '') and value not in (None, ''):
                        cur[field] = value
                evidence.setdefault(key, set()).update(
                    self.upsert_reference(refs[k]) for k in ds.get('evidence') or [] if k in refs)
            for ev in doc.get('evaluations') or []:
                key = ev.get('dataset_key')
                if key and key not in merged:
                    merged[key] = {'name': ev.get('benchmark') or key, 'hf_id': None if key.startswith('slug:') else key}
            for td in (doc.get('transformation') or {}).get('datasets') or []:
                if td.get('dataset_key') and td['dataset_key'] not in merged:
                    merged[td['dataset_key']] = {'name': td['dataset_key']}
        for ds in list(merged.values()):
            for parent in ds.get('parents') or []:
                key = parent.get('dataset_key')
                if key and key not in merged:
                    merged[key] = {'name': key.removeprefix('slug:'), 'hf_id': None if key.startswith('slug:') else key}
        # _datasets_*.json: follow-up research on datasets the model research left incomplete; fills gaps only
        for key, extra in (supplements or {}).items():
            if key not in merged:
                continue
            for field in ('name', 'hf_id', 'uri', 'version', 'license', 'provider', 'description', 'size'):
                if merged[key].get(field) in (None, '') and extra.get(field) not in (None, ''):
                    merged[key][field] = extra[field]
            if (extra.get('reference') or {}).get('uri'):
                evidence.setdefault(key, set()).add(self.upsert_reference(extra['reference']))

        # design field DATASET.role: every role the dataset plays anywhere in the catalog
        roles: dict[str, set] = {k: set() for k in merged}
        for doc in docs:
            for td in (doc.get('transformation') or {}).get('datasets') or []:
                if td.get('dataset_key') in roles:
                    roles[td['dataset_key']].add(DATASET_ROLE_GROUP[pick(td.get('role'), DATASET_ROLES, 'other')])
            for ev in doc.get('evaluations') or []:
                if ev.get('dataset_key') in roles:
                    roles[ev['dataset_key']].add('evaluation')

        def roots(key, seen=()):
            parents = [p['dataset_key'] for p in merged.get(key, {}).get('parents') or []
                       if p.get('dataset_key') in merged and p['dataset_key'] not in seen]
            return [key] if not parents else sorted({r for p in parents for r in roots(p, seen + (key,))})

        for key, ds in merged.items():
            extra = self.enrich_ds.get(ds.get('hf_id') or key) or {}
            parents = [p for p in ds.get('parents') or [] if p.get('dataset_key') in merged and p['dataset_key'] != key]
            pv_id = self.replace_provenance(
                f'dataset:{key}',
                ', '.join(merged[r].get('name') or r for r in roots(key)) if parents else None,
                ds.get('provider'),
                [f'dataset:{p["dataset_key"]}' for p in parents],
                parents[0].get('relation') or 'derived_from' if parents else 'original',
                evidence.get(key, ()),
                {'disclosure_status': pick(ds.get('disclosure_status'), DISCLOSURE, 'disclosed')})
            license_ = ds.get('license') or extra.get('license')
            self.execute(
                """INSERT INTO dataset (`identity`, version, role, processing, license, provenance, extensions)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)
                   ON DUPLICATE KEY UPDATE version = VALUES(version), role = VALUES(role),
                     processing = VALUES(processing), license = VALUES(license), provenance = VALUES(provenance),
                     extensions = VALUES(extensions)""",
                (key, ds.get('version') or extra.get('version'), ','.join(sorted(roles[key])) or None,
                 js(ds.get('processing')), license_, pv_id,
                 js({'name': ds.get('name') or key, 'hf_id': ds.get('hf_id'), 'uri': ds.get('uri'),
                     'description': ds.get('description'), 'size': ds.get('size'), 'modality': ds.get('modality'),
                     'provider': ds.get('provider'), 'hf_last_modified': extra.get('last_modified')})))
            self.bump('dataset')
            self.execute('DELETE FROM license_policy WHERE subject = %s', (f'dataset:{key}',))
            if license_ and not re.search(r'unknown|not (stated|specified|disclosed)|n/a|^none$', license_, re.I):
                self.insert_license(f'dataset:{key}', {'name': license_, 'kind': 'declared'})
        return merged

    # --- per model ---------------------------------------------------------------------------
    def load_model(self, doc: dict, datasets: dict):
        model_id = doc['model_id']
        if model_id not in self.known_models:
            print(f'  ! skip {model_id}: not in model_info')
            return
        for sql in ('DELETE FROM evaluation WHERE model = %s', 'DELETE FROM transformation WHERE output = %s',
                    'DELETE FROM safety_ethics WHERE subject = %s', 'DELETE FROM model WHERE `identity` = %s'):
            self.execute(sql, (model_id,))
        self.execute('DELETE FROM license_policy WHERE subject = %s', (f'model:{model_id}',))
        refs = {r['key']: self.upsert_reference(r) for r in doc.get('references', []) if r.get('key')}
        ref_uri = {r['key']: r.get('uri') for r in doc.get('references', []) if r.get('key')}

        tr = doc.get('transformation') or {}
        inputs = []
        for inp in tr.get('inputs') or []:
            name = inp.get('model_id') or inp.get('external_model_name')
            if name:
                inputs.append({'model': name, 'role': pick(inp.get('role'), INPUT_ROLES, 'base'),
                               'external': name not in self.known_models})
        pv = doc.get('provenance') or {}
        pv_id = self.replace_provenance(
            f'model:{model_id}', pv.get('origin'), pv.get('provider'),
            [f'model:{i["model"]}' for i in inputs if i['role'] in PARENT_ROLES],
            pv.get('relation'), [refs.get(k) for k in pv.get('evidence') or []],
            {'disclosure_status': pick(pv.get('disclosure_status'), DISCLOSURE, 'disclosed'), 'notes': pv.get('notes')})

        m = doc.get('model') or {}
        architecture = {'family': m.get('architecture_family'), 'parameter_count': to_int(m.get('parameter_count')),
                        'context_length': to_int(m.get('context_length')), **(m.get('architecture_details') or {})}
        self.execute(
            """INSERT INTO model (`identity`, architecture, tokenizer, modality, intended_use, capabilities,
                 limitations, provenance, extensions) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (model_id, js(architecture), js({'name': m.get('tokenizer'), 'vocab_size': to_int(m.get('vocab_size'))}),
             js({'input': m.get('modality_input'), 'output': m.get('modality_output'), 'languages': m.get('languages')}),
             m.get('intended_use'), js(m.get('capabilities')), js(m.get('limitations')), pv_id,
             js({'release_date': to_date(m.get('release_date')), 'knowledge_cutoff': m.get('knowledge_cutoff'),
                 'unknowns': doc.get('unknowns'), 'evidence': sorted({r for r in refs.values() if r})})))
        self.bump('model')

        hyper = dict(tr.get('hyperparameters') or {})
        if tr.get('adapter_config'):
            hyper['adapter'] = tr['adapter_config']
        tr_datasets = [{'dataset': d['dataset_key'], 'role': pick(d.get('role'), DATASET_ROLES, 'other')}
                       for d in tr.get('datasets') or [] if d.get('dataset_key') in datasets]
        self.execute(
            """INSERT INTO transformation (input, output, method, objective, hyperparameters, datasets, `timestamp`,
                 extensions) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
            (js(inputs), model_id, json.dumps(tr.get('methods') or [], ensure_ascii=False), tr.get('objective'),
             js(hyper), js(tr_datasets), to_date(tr.get('performed_at')),
             js({'notes': tr.get('notes'), 'evidence': [ref_uri[k] for k in tr.get('evidence') or [] if k in ref_uri]})))
        self.bump('transformation')

        for ev in doc.get('evaluations') or []:
            if not ev.get('benchmark'):
                continue
            config = {'benchmark': ev['benchmark'], **(ev.get('configuration') or {})}
            score = to_decimal(ev.get('value'))
            source = ref_uri.get(ev.get('reference_key'))
            self.execute(
                """INSERT INTO evaluation (model, dataset, configuration, metric, score, `timestamp`, extensions)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                (model_id, ev.get('dataset_key') if ev.get('dataset_key') in datasets else None, js(config),
                 ev.get('metric'), score, self.published_at(source) if source else None,
                 js({'score_text': ev.get('value_text') or (None if score is not None or ev.get('value') is None
                                                            else str(ev.get('value'))),
                     'baseline_model': ev.get('baseline_model_id'), 'baseline_score': ev.get('baseline_value'),
                     'evaluator_model': ev.get('evaluator_model'), 'reference': source})))
            self.bump('evaluation')

        safety = doc.get('safety') or {}
        columns = {c: [] for c in SAFETY_FIELDS.values()}
        for item in safety.get('items') or []:
            field = SAFETY_FIELDS.get(pick(item.get('type'), set(SAFETY_FIELDS), ''))
            if field and item.get('description'):
                columns[field].append({'description': item['description'],
                                       'reference': ref_uri.get(item.get('reference_key'))})
        if any(columns.values()) or safety.get('risk_level'):
            self.execute(
                """INSERT INTO safety_ethics (subject, safety_risk, ethical_considerations, prohibited_use, mitigation,
                     extensions) VALUES (%s, %s, %s, %s, %s, %s)""",
                (model_id, js(columns['safety_risk']), js(columns['ethical_considerations']),
                 js(columns['prohibited_use']), js(columns['mitigation']),
                 js({'risk_summary': safety.get('risk_level')})))
            self.bump('safety_ethics')

        license_source = next((ref_uri[k] for k in ref_uri if 'licen' in k.lower()), None)
        for lic in doc.get('licenses') or []:
            self.insert_license(f'model:{model_id}', lic, license_source)


def main():
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'data' / 'aibom_research'
    docs = [json.loads(p.read_text(encoding='utf-8')) for p in sorted(src.glob('*.json')) if not p.name.startswith('_')]
    enrichment_file = src / '_enrichment.json'
    enrichment = json.loads(enrichment_file.read_text(encoding='utf-8')) if enrichment_file.exists() else {}
    supplements = {}
    for p in sorted(src.glob('_datasets_*.json')):
        supplements.update(json.loads(p.read_text(encoding='utf-8')).get('datasets', {}))
    print(f'{len(docs)} research documents from {src} (enrichment: {"yes" if enrichment else "no"}, '
          f'dataset supplements: {len(supplements)})')
    conn = connect()
    try:
        loader = Loader(conn, enrichment)
        loader.canonicalize_licenses(docs)
        datasets = loader.load_datasets(docs, supplements)
        for doc in docs:
            loader.load_model(doc, datasets)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    for key, value in sorted(loader.stats.items()):
        print(f'{key:16} {value}')


if __name__ == '__main__':
    main()
