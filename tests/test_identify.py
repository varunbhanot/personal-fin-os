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
    assert profile.closing_rounded_to_rupee is False


def test_profile_settings_override_defaults(tmp_path):
    write_profile(
        tmp_path,
        "hdfc-tataneu",
        "HDFC",
        period_slack_days="5",
        date_formats="['%d %b %Y']",
        closing_rounded_to_rupee="true",
    )

    profile = load_profiles(tmp_path)[0]

    assert profile.period_slack_days == 5
    assert profile.date_formats == ("%d %b %Y",)
    assert profile.closing_rounded_to_rupee is True


@pytest.mark.parametrize("value", ["'sometimes'", "'true'", "1", "''"])
def test_a_non_boolean_rounding_setting_is_a_config_error(tmp_path, value):
    write_profile(tmp_path, "x", "X", closing_rounded_to_rupee=value)

    with pytest.raises(ConfigError, match="closing_rounded_to_rupee"):
        load_profiles(tmp_path)


def test_extra_date_formats_add_to_the_defaults(tmp_path):
    write_profile(tmp_path, "x", "X", extra_date_formats="['%d %b, %Y']")

    profile = load_profiles(tmp_path)[0]

    assert "%d/%m/%Y" in profile.date_formats
    assert profile.date_formats[-1] == "%d %b, %Y"


def test_extra_date_formats_must_be_a_list_of_text(tmp_path):
    write_profile(tmp_path, "x", "X", extra_date_formats="'%d %b, %Y'")

    with pytest.raises(ConfigError, match="extra_date_formats"):
        load_profiles(tmp_path)


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
    profiles = {p.id: p for p in load_profiles()}

    assert "hdfc-tataneu" in profiles
    # Both seen on the first real HDFC statement.
    assert profiles["hdfc-tataneu"].closing_rounded_to_rupee is True
    assert "%d %b, %Y" in profiles["hdfc-tataneu"].date_formats


def test_a_non_numeric_slack_is_a_config_error(tmp_path):
    write_profile(tmp_path, "x", "X", period_slack_days="soon")

    with pytest.raises(ConfigError, match="period_slack_days"):
        load_profiles(tmp_path)
