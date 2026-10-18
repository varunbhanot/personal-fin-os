from pathlib import Path

import pytest

from finos.errors import ConfigError, UnknownSource
from finos.identify import identify, load_profiles

PROFILE = """
id: {id}
kind: card
markers: [{markers}]
password_secret: PW_TEST
hints: Amounts ending in Cr are credits.
"""


def write_profile(folder: Path, id: str, markers: str, **extra: str) -> None:
    text = PROFILE.format(id=id, markers=markers)
    text += "".join(f"{key}: {value}\n" for key, value in extra.items())
    (folder / f"{id}.yaml").write_text(text)


def test_identifies_the_profile_whose_markers_all_appear(tmp_path):
    write_profile(tmp_path, "hdfc-tataneu", "HDFC Bank, Tata Neu")
    write_profile(tmp_path, "sbi-card", "SBI Card, Aurum")
    profiles = load_profiles(tmp_path)

    profile = identify("Tata Neu Infinity HDFC BANK Credit Card Statement", profiles)

    assert profile.id == "hdfc-tataneu"
    assert profile.kind == "card"
    assert profile.password_secret == "PW_TEST"


def test_no_match_is_an_unknown_source(tmp_path):
    write_profile(tmp_path, "hdfc-tataneu", "HDFC Bank, Tata Neu")

    with pytest.raises(UnknownSource, match="no source profile"):
        identify("Kotak Mahindra Bank statement", load_profiles(tmp_path))


def test_more_than_one_match_is_an_unknown_source(tmp_path):
    write_profile(tmp_path, "sbi-card", "SBI")
    write_profile(tmp_path, "sbi-bank", "State Bank")

    with pytest.raises(UnknownSource, match="sbi-bank, sbi-card"):
        identify("SBI State Bank of India", load_profiles(tmp_path))


def test_profile_defaults(tmp_path):
    write_profile(tmp_path, "hdfc-tataneu", "HDFC")

    profile = load_profiles(tmp_path)[0]

    assert profile.period_slack_days == 0
    assert "%d/%m/%Y" in profile.date_formats


def test_profile_settings_override_defaults(tmp_path):
    write_profile(
        tmp_path, "hdfc-tataneu", "HDFC", period_slack_days="5", date_formats="['%d %b %Y']"
    )

    profile = load_profiles(tmp_path)[0]

    assert profile.period_slack_days == 5
    assert profile.date_formats == ("%d %b %Y",)


@pytest.mark.parametrize(
    "broken",
    [
        "id: x\nkind: savings\nmarkers: [X]\npassword_secret: PW_X\nhints: h\n",
        "id: x\nkind: card\nmarkers: []\npassword_secret: PW_X\nhints: h\n",
        "id: x\nkind: card\nmarkers: [X]\nhints: h\n",
        "- not a mapping\n",
    ],
)
def test_malformed_profiles_are_rejected(tmp_path, broken):
    (tmp_path / "x.yaml").write_text(broken)

    with pytest.raises(ConfigError, match="x.yaml"):
        load_profiles(tmp_path)


def test_the_shipped_profiles_load():
    profiles = load_profiles()

    assert "hdfc-tataneu" in {p.id for p in profiles}


def test_a_non_numeric_slack_is_a_config_error(tmp_path):
    write_profile(tmp_path, "x", "X", period_slack_days="soon")

    with pytest.raises(ConfigError, match="period_slack_days"):
        load_profiles(tmp_path)
