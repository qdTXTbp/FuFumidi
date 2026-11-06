# -*- coding: utf-8 -*-
"""msst_config_heal 的离线回归：五级查找顺序、内置复制、上游缓存、autoconfig 分支、失败不假成功。

全部走 tmp_path + stub，不访问外网。
"""

import json
import os
import subprocess
import sys

import pytest

_ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _ENGINE not in sys.path:
    sys.path.insert(0, _ENGINE)

import msst_config_heal as H  # noqa: E402

VALID = "model:\n  dim: 384\n  depth: 6\n  heads: 8\n  dim_head: 64\n  num_bands: 60\n"


@pytest.fixture(autouse=True)
def _fast_retry(monkeypatch):
    monkeypatch.setattr(H, "_sleep", lambda *_a, **_k: None)


def _fake_bundled(tmp_path, entries=None, files=None):
    directory = tmp_path / "bundled"
    directory.mkdir()
    (directory / "index.json").write_text(json.dumps(entries or {}), encoding="utf-8")
    for name, text in (files or {}).items():
        (directory / name).write_text(text, encoding="utf-8")
    return directory


def _make_model(tmp_path, name="m.ckpt"):
    root = tmp_path / "root"
    model_dir = root / "models" / "vocal" / "m"
    model_dir.mkdir(parents=True)
    model = model_dir / name
    model.write_bytes(b"fake-weights")
    return root, model_dir, model


def _norm(path):
    return os.path.normcase(os.path.abspath(str(path)))


# ---------------------------------------------------------------------------
# 校验口径
# ---------------------------------------------------------------------------
def test_validate_config_rejects_garbage_and_accepts_valid(tmp_path):
    garbage = tmp_path / "bad.yaml"
    garbage.write_text("this file is definitely not a separation config at all, just text", encoding="utf-8")
    assert H._validate_config(str(garbage))[0] is False

    empty = tmp_path / "empty.yaml"
    empty.write_text("", encoding="utf-8")
    assert H._validate_config(str(empty))[0] is False

    good = tmp_path / "good.yaml"
    good.write_text(VALID, encoding="utf-8")
    assert H._validate_config(str(good))[0] is True

    assert H._validate_config(str(tmp_path / "missing.yaml"))[0] is False


# ---------------------------------------------------------------------------
# 查找顺序
# ---------------------------------------------------------------------------
def test_model_dir_config_wins(tmp_path, monkeypatch):
    bundled = _fake_bundled(
        tmp_path,
        {"m.ckpt": {"config": "wanted.yaml", "arch": "BS-Roformer"}},
        {"wanted.yaml": VALID.replace("384", "999")},
    )
    monkeypatch.setattr(H, "BUNDLED_DIR", str(bundled))
    root, model_dir, model = _make_model(tmp_path)
    (model_dir / "wanted.yaml").write_text(VALID, encoding="utf-8")
    cache = root / "models" / "_configs"
    cache.mkdir(parents=True)
    (cache / "wanted.yaml").write_text(VALID.replace("384", "512"), encoding="utf-8")

    result = H.heal(str(root), str(model))

    assert result["ok"] is True and result["from"] == "model"
    assert _norm(result["config"]) == _norm(model_dir / "wanted.yaml")
    assert "999" not in open(result["config"], encoding="utf-8").read()


def test_cache_used_when_model_dir_has_no_config(tmp_path, monkeypatch):
    bundled = _fake_bundled(
        tmp_path, {"m.ckpt": {"config": "wanted.yaml", "arch": "BS-Roformer"}}, {"wanted.yaml": VALID}
    )
    monkeypatch.setattr(H, "BUNDLED_DIR", str(bundled))
    root, _model_dir, model = _make_model(tmp_path)
    cache = root / "models" / "_configs"
    cache.mkdir(parents=True)
    (cache / "wanted.yaml").write_text(VALID, encoding="utf-8")

    result = H.heal(str(root), str(model))

    assert result["ok"] is True and result["from"] == "cache"
    assert _norm(result["config"]) == _norm(cache / "wanted.yaml")


def test_builtin_config_is_copied_into_configs_cache(tmp_path, monkeypatch):
    bundled = _fake_bundled(
        tmp_path,
        {"m.ckpt": {"config": "wanted.yaml", "arch": "BS-Roformer"}},
        {"wanted.yaml": VALID},
    )
    monkeypatch.setattr(H, "BUNDLED_DIR", str(bundled))
    root, _model_dir, model = _make_model(tmp_path)

    result = H.heal(str(root), str(model))

    assert result["ok"] is True and result["from"] == "builtin"
    cached = root / "models" / "_configs" / "wanted.yaml"
    assert cached.is_file()
    assert cached.read_text(encoding="utf-8") == VALID
    assert _norm(result["config"]) == _norm(cached)


def test_upstream_config_is_fetched_and_cached(tmp_path, monkeypatch):
    bundled = _fake_bundled(tmp_path, {"m.ckpt": {"config": "wanted.yaml", "arch": "BS-Roformer"}})
    monkeypatch.setattr(H, "BUNDLED_DIR", str(bundled))
    root, _model_dir, model = _make_model(tmp_path)
    urls = []

    def fake_get(url):
        urls.append(url)
        return VALID.encode("utf-8")

    monkeypatch.setattr(H, "_http_get", fake_get)

    def no_autoconfig(*_a, **_k):
        raise AssertionError("内置/上游命中后不应调用 autoconfig")

    monkeypatch.setattr(H, "_run_autoconfig", no_autoconfig)

    result = H.heal(str(root), str(model))

    assert result["ok"] is True and result["from"] == "upstream"
    cached = root / "models" / "_configs" / "wanted.yaml"
    assert cached.is_file() and cached.read_text(encoding="utf-8") == VALID
    assert _norm(result["config"]) == _norm(cached)
    assert urls and urls[0].startswith("https://raw.githubusercontent.com/monologue82/Models/main/configs/")


def test_invalid_model_dir_config_is_skipped(tmp_path, monkeypatch):
    bundled = _fake_bundled(tmp_path, {"m.ckpt": {"config": "wanted.yaml"}}, {"wanted.yaml": VALID})
    monkeypatch.setattr(H, "BUNDLED_DIR", str(bundled))
    root, model_dir, model = _make_model(tmp_path)
    (model_dir / "wanted.yaml").write_text("not a valid config but long enough to pass size limit", encoding="utf-8")
    cache = root / "models" / "_configs"
    cache.mkdir(parents=True)
    (cache / "wanted.yaml").write_text(VALID, encoding="utf-8")

    result = H.heal(str(root), str(model))

    assert result["ok"] is True and result["from"] == "cache"


# ---------------------------------------------------------------------------
# autoconfig 分支
# ---------------------------------------------------------------------------
def test_autoconfig_fallback_receives_index_arch(tmp_path, monkeypatch):
    bundled = _fake_bundled(tmp_path, {"m.ckpt": {"arch": "HTDemucs"}})
    monkeypatch.setattr(H, "BUNDLED_DIR", str(bundled))
    root, model_dir, model = _make_model(tmp_path)
    calls = []

    def stub_autoconfig(r, m, arch):
        calls.append((r, m, arch))
        gen = os.path.join(r, "cache", "msst_autocfg", "gen.yaml")
        os.makedirs(os.path.dirname(gen), exist_ok=True)
        with open(gen, "w", encoding="utf-8") as f:
            f.write(VALID)
        return gen

    monkeypatch.setattr(H, "_run_autoconfig", stub_autoconfig)

    result = H.heal(str(root), str(model))

    assert result["ok"] is True and result["from"] == "generated"
    assert calls == [(os.path.abspath(str(root)), os.path.abspath(str(model)), "HTDemucs")]
    assert (model_dir / "gen.yaml").is_file(), "生成的配置应放进模型目录"
    assert _norm(result["config"]) == _norm(model_dir / "gen.yaml")


def test_failure_never_fake_success(tmp_path, monkeypatch):
    bundled = _fake_bundled(tmp_path, {})
    monkeypatch.setattr(H, "BUNDLED_DIR", str(bundled))
    root = tmp_path / "root"
    model = root / "models" / "vocal" / "m" / "m.ckpt"  # 权重也不存在
    monkeypatch.setattr(H, "_run_autoconfig", lambda *_a, **_k: None)

    result = H.heal(str(root), str(model))

    assert result["ok"] is False
    assert result["error"] and "找不到可用配置" in result["error"]
    assert "config" not in result


# ---------------------------------------------------------------------------
# CLI 契约
# ---------------------------------------------------------------------------
def test_cli_outputs_single_json_line(tmp_path, monkeypatch, capsys):
    bundled = _fake_bundled(
        tmp_path, {"m.ckpt": {"config": "wanted.yaml", "arch": "BS-Roformer"}}, {"wanted.yaml": VALID}
    )
    monkeypatch.setattr(H, "BUNDLED_DIR", str(bundled))
    root, _model_dir, model = _make_model(tmp_path)

    rc = H.main(["--root", str(root), "--model", str(model), "--arch", "BS-Roformer"])
    out_lines = capsys.readouterr().out.splitlines()

    assert rc == 0
    assert len(out_lines) == 1, "stdout 必须只有一行 JSON"
    data = json.loads(out_lines[0])
    assert data["ok"] is True and data["from"] == "builtin" and os.path.isfile(data["config"])


def test_cli_exit_code_is_nonzero_on_failure(tmp_path, monkeypatch, capsys):
    bundled = _fake_bundled(tmp_path, {})
    monkeypatch.setattr(H, "BUNDLED_DIR", str(bundled))
    root = tmp_path / "root"
    model = root / "models" / "m.ckpt"
    monkeypatch.setattr(H, "_run_autoconfig", lambda *_a, **_k: None)

    rc = H.main(["--root", str(root), "--model", str(model)])
    out_lines = capsys.readouterr().out.splitlines()

    assert rc == 1
    assert len(out_lines) == 1
    assert json.loads(out_lines[0])["ok"] is False


def _pick_real_bundled_entry():
    directory = os.path.join(_ENGINE, "msst_configs")
    try:
        with open(os.path.join(directory, "index.json"), encoding="utf-8") as f:
            index = json.load(f)
    except (OSError, ValueError):
        return None
    for name, entry in index.items():
        config = (entry or {}).get("config")
        if config and os.path.isfile(os.path.join(directory, os.path.basename(config))):
            return name, config
    return None


def test_cli_subprocess_copies_real_bundled_config(tmp_path):
    picked = _pick_real_bundled_entry()
    if not picked:
        pytest.skip("仓库里没有可用的内置配置")
    model_name, config_name = picked
    root = tmp_path / "root"
    model_dir = root / "models" / "vocal" / "x"
    model_dir.mkdir(parents=True)
    model = model_dir / model_name
    model.write_bytes(b"fake-weights")
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"

    proc = subprocess.run(
        [
            sys.executable,
            os.path.join(_ENGINE, "msst_config_heal.py"),
            "--root",
            str(root),
            "--model",
            str(model),
        ],
        capture_output=True,
        env=env,
        timeout=120,
    )

    assert proc.returncode == 0, proc.stderr.decode("utf-8", "replace")
    lines = [line for line in proc.stdout.decode("utf-8").splitlines() if line.strip()]
    assert len(lines) == 1
    data = json.loads(lines[0])
    assert data["ok"] is True and data["from"] == "builtin"
    assert os.path.isfile(data["config"])
    assert os.path.basename(data["config"]).lower() == os.path.basename(config_name).lower()
