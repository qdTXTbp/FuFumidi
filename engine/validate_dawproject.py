# -*- coding: utf-8 -*-
"""用 DAWproject 官方 XSD 校验 project.xml / metadata.xml（P2-5 格式合规门禁）。

官方 schema 来源：https://github.com/bitwig/dawproject（Project.xsd / MetaData.xsd）
本仓库副本在 docs/dawproject/，随文档保留出处。
"""
import argparse
import json
import sys


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--schema-dir', required=True)
    ap.add_argument('--project', required=True)
    ap.add_argument('--metadata', default='')
    a = ap.parse_args(argv)
    try:
        from lxml import etree
    except Exception as e:  # noqa: BLE001
        print(json.dumps({'ok': False, 'code': 'backend-missing',
                          'error': '缺少 lxml（pip install lxml）：%s' % str(e)[:160]}, ensure_ascii=False))
        return 2
    import os
    results = []
    ok = True
    pairs = [('project.xml', a.project, 'Project.xsd')]
    if a.metadata:
        pairs.append(('metadata.xml', a.metadata, 'MetaData.xsd'))
    for label, xml_path, xsd_name in pairs:
        xsd_path = os.path.join(a.schema_dir, xsd_name)
        try:
            schema = etree.XMLSchema(etree.parse(xsd_path))
            doc = etree.parse(xml_path)
            valid = schema.validate(doc)
            errors = [{'line': e.line, 'message': e.message[:300]} for e in schema.error_log[:10]]
        except Exception as e:  # noqa: BLE001
            valid = False
            errors = [{'line': 0, 'message': str(e)[:300]}]
        results.append({'file': label, 'valid': bool(valid), 'errors': errors})
        ok = ok and valid
    print(json.dumps({'ok': ok, 'results': results}, ensure_ascii=False))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
