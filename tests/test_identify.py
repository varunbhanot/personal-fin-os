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


def test_no_match_names_the_missing_markers_of_each_profile(tmp_path):
    write_profile(tmp_path, "hdfc-tataneu", "HDFC Bank, Tata Neu")
    write_profile(tmp_path, "sbi-card", "SBI Card, Minimum Amount Due")

    with pytest.raises(UnknownSource) as error:
        identify("HDFC Bank Millennia card. Minimum Amount Due 500.00", load_profiles(tmp_path))

    message = str(error.value)
    assert message.endswith('Missing markers: hdfc-tataneu: "Tata Neu"; sbi-card: "SBI Card".')
    # Only the profiles' own marker text is named, never the statement's.
    assert "Millennia" not in message


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
    assert profile.account_digits == 4


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


def test_transfer_markers_are_optional_text(tmp_path):
    write_profile(tmp_path, "x", "X", transfer_markers="[UTIB, Axis Bank]")
    write_profile(tmp_path, "y", "Y")

    x, y = load_profiles(tmp_path)

    assert x.transfer_markers == ("UTIB", "Axis Bank")
    assert y.transfer_markers == ()


@pytest.mark.parametrize("value", ["UTIB", "[UTIB, '']", "[1]"])
def test_transfer_markers_must_be_a_list_of_text(tmp_path, value):
    write_profile(tmp_path, "x", "X", transfer_markers=value)

    with pytest.raises(ConfigError, match="transfer_markers"):
        load_profiles(tmp_path)


@pytest.mark.parametrize(
    "broken",
    [
        "id: x\nkind: savings\nmarkers: [X]\npassword_secret: PW_X\nhints: h\n",
        "id: x\nkind: card\nmarkers: []\npassword_secret: PW_X\nhints: h\n",
        "id: x\nkind: card\nmarkers: [X]\npassword_secret: [PW_X]\nhints: h\n",
        # A blank value is a mistake, not "no password": that is said by leaving the key out.
        "id: x\nkind: card\nmarkers: [X]\npassword_secret:\nhints: h\n",
        "id: x\nkind: card\nmarkers: [X]\npassword_secret: ''\nhints: h\n",
        "id: x\nkind: card\nmarkers: [X]\npassword_secret: '  '\nhints: h\n",
        "- not a mapping\n",
    ],
)
def test_malformed_profiles_are_rejected(tmp_path, broken):
    (tmp_path / "x.yaml").write_text(broken)

    with pytest.raises(ConfigError, match="x.yaml"):
        load_profiles(tmp_path)


def test_the_shipped_profiles_load():
    profiles = {p.id: p for p in load_profiles()}

    assert {id: p.kind for id, p in profiles.items()} == {
        "axis-bank": "bank",
        "canara-bank": "bank",
        "hdfc-tataneu": "card",
        "sbi-bank": "bank",
        "sbi-card": "card",
    }
    # unlock() tries every PW_* secret, but each source with a password still needs its own.
    secrets = [p.password_secret for p in profiles.values() if p.password_secret]
    assert sorted(secrets) == ["PW_AXIS_BANK", "PW_HDFC_TATANEU", "PW_SBI_BANK", "PW_SBI_CARD"]
    # finos identify showed the Canara statement opening with no password.
    assert profiles["canara-bank"].password_secret is None
    # Seen with finos identify and the first sync: the card statement shows the last two
    # digits of the card number, and the Axis statement masks every digit.
    assert {id: p.account_digits for id, p in profiles.items()} == {
        "axis-bank": 0,
        "canara-bank": 4,
        "hdfc-tataneu": 4,
        "sbi-bank": 4,
        "sbi-card": 2,
    }
    # Both seen on the first real HDFC statement.
    assert profiles["hdfc-tataneu"].closing_rounded_to_rupee is True
    assert "%d %b, %Y" in profiles["hdfc-tataneu"].date_formats
    # Every source can be named by another account's narration.
    assert all(p.transfer_markers for p in profiles.values())


def test_a_source_whose_pdfs_have_no_password_names_no_secret(tmp_path):
    (tmp_path / "x.yaml").write_text("id: x\nkind: bank\nmarkers: [X]\nhints: h\n")

    assert load_profiles(tmp_path)[0].password_secret is None


def test_a_non_numeric_slack_is_a_config_error(tmp_path):
    write_profile(tmp_path, "x", "X", period_slack_days="soon")

    with pytest.raises(ConfigError, match="period_slack_days"):
        load_profiles(tmp_path)


# Synthetic first lines of each source's statement. A bank statement names the cards it pays
# in its narrations, and a card statement names the bank a payment came from.
AXIS_TEXT = (
    "AXIS BANK\nStatement of Account No 912010000009876 Savings\n"
    "IFSC UTIB0001234 Nominee Registered Y\n"
    "Date Value Date Description Withdrawal Deposit Balance\n"
    "05-09-2026 05-09-2026 BIL/BPAY/SBI Card bill 3,937.82 46,062.18\n"
    "08-09-2026 08-09-2026 UPI/HDFC Bank Tata Neu card payment 2,000.00 44,062.18\n"
    "10-09-2026 10-09-2026 NEFT/CNRB0001234/Canara Bank own account 20,000.00 24,062.18\n"
    "12-09-2026 12-09-2026 NEFT/SBIN0001234/State Bank of India own account 5,000.00 19,062.18"
)
# The statement downloaded from Axis net banking: no value date column.
AXIS_DOWNLOAD_TEXT = (
    "Axis Bank Ltd\nStatement of Account No :912010000009876 for the period 01-01-2026 to\n"
    "IFSC Code :UTIB0001234 Nominee Registered :Y\n"
    "Tran Date Chq No Particulars Debit Credit Balance Init. Br\n"
    "05-01-2026 BIL/BPAY/SBI Card bill 3,937.82 46,062.18 1234\n"
    "08-01-2026 UPI/HDFC Bank Tata Neu card payment 2,000.00 44,062.18 1234"
)
SBI_BANK_TEXT = (
    "State Bank of India Statement of Account\n"
    "Account Number : XXXXXXX4321 CIF No. 900001 IFSC SBIN0001234 Branch Code 1234\n"
    "Drawing Power 0.00 Clear Balance 19,000.00\n"
    "01/09/2026 Brought Forward 10,000.00\n"
    "05/09/2026 NEFT AXIS BANK own account 5,000.00 15,000.00\n"
    "08/09/2026 NEFT CNRB0001234 Canara Bank own account 1,000.00 14,000.00\n"
    "10/09/2026 SBI Card bill payment 2,000.00 12,000.00\n"
    "12/09/2026 UPI HDFC Bank Tata Neu card payment 1,000.00 11,000.00"
)
CANARA_TEXT = (
    "Canara Bank Customer Id 900001 Branch Code 1234 Branch Name MG Road IFSC CNRB0001234\n"
    "Date Particulars Deposits Withdrawals Balance\n"
    "22-09-2026 NEFT AXIS BANK own account 20,000.00 45,000.00\n"
    "25-09-2026 UPI/SBI Card bill 3,937.82 41,062.18\n"
    "28-09-2026 UPI/HDFC Bank Tata Neu card payment 2,000.00 39,062.18"
)
SBI_CARD_TEXT = (
    "SBI Card Statement for Credit Card Number XXXX XXXX XXXX 5678\n"
    "Total Amount Due 3,937.82 Minimum Amount Due 200.00\n"
    "20 Sep 26 PAYMENT RECEIVED AXIS BANK 12,000.00 C\n"
    "22 Sep 26 TATA NEU BIGBASKET 1,250.00 D"
)
HDFC_TEXT = (
    "HDFC Bank Tata Neu Infinity Credit Card Statement\n"
    "Total Amount Due 1,500.00 Minimum Amount Due 200.00\n"
    "20 Sep 2026 NETBANKING PAYMENT AXIS BANK 2,000.00 Cr"
)


@pytest.mark.parametrize(
    ("text", "source"),
    [
        (AXIS_TEXT, "axis-bank"),
        (AXIS_DOWNLOAD_TEXT, "axis-bank"),
        (CANARA_TEXT, "canara-bank"),
        (SBI_BANK_TEXT, "sbi-bank"),
        (SBI_CARD_TEXT, "sbi-card"),
        (HDFC_TEXT, "hdfc-tataneu"),
    ],
    ids=["axis-bank", "axis-bank-download", "canara-bank", "sbi-bank", "sbi-card", "hdfc-tataneu"],
)
def test_each_source_is_identified_despite_other_sources_in_its_narrations(text, source):
    assert identify(text, load_profiles()).id == source


def test_account_digits_can_be_fewer_than_four(tmp_path):
    write_profile(tmp_path, "x", "X", account_digits="2")

    assert load_profiles(tmp_path)[0].account_digits == 2


@pytest.mark.parametrize("value", ["5", "-1", "two", "true", "2.5"])
def test_account_digits_must_be_a_whole_number_from_0_to_4(tmp_path, value):
    write_profile(tmp_path, "x", "X", account_digits=value)

    with pytest.raises(ConfigError, match="account_digits"):
        load_profiles(tmp_path)


def test_markers_match_across_line_breaks_and_repeated_spaces(tmp_path):
    write_profile(tmp_path, "sbi-card", "SBI Card, Minimum Amount Due")

    profile = identify("SBI  Card statement\nMinimum Amount\nDue 200.00", load_profiles(tmp_path))

    assert profile.id == "sbi-card"
