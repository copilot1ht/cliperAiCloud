from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_local_cloud_starter_targets_the_canonical_cloud_workspace():
    script = (ROOT / "scripts" / "start-local-cloud.ps1").read_text(
        encoding="utf-8"
    )

    assert 'Join-Path $workspaceRoot "Cliper Ai Cloud"' in script
    assert 'Join-Path $desktopRoot "WEB PRODUCTION SAAS"' in script
    assert 'Cloud kanonis belum dikonfigurasi' in script


def test_local_cloud_starter_rejects_a_port_owned_by_another_workspace():
    script = (ROOT / "scripts" / "start-local-cloud.ps1").read_text(
        encoding="utf-8"
    )

    assert "function Assert-WorkspacePort" in script
    assert 'Port $Port sedang dipakai $ServiceName dari workspace lain' in script
    assert 'Assert-WorkspacePort 4100 "Cliper Cloud API"' in script
    assert 'Assert-WorkspacePort 3000 "Cliper Cloud web"' in script


def test_local_cloud_starter_only_stops_legacy_processes_when_explicitly_requested():
    script = (ROOT / "scripts" / "start-local-cloud.ps1").read_text(
        encoding="utf-8"
    )

    assert "[switch]$StopLegacy" in script
    assert "function Stop-LegacyCloudServices" in script
    assert "Name = 'node.exe'" in script
    assert "if ($StopLegacy)" in script


def test_local_cloud_starter_syncs_the_database_backed_local_admin():
    script = (ROOT / "scripts" / "start-local-cloud.ps1").read_text(
        encoding="utf-8"
    )

    assert "accounts:sync-bootstrap" in script
    assert "Sinkronisasi admin lokal gagal" in script
