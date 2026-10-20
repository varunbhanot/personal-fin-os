from decimal import Decimal

import pytest

from finos.config import DEFAULT_MODEL, load_settings
from finos.errors import ConfigError

REQUIRED = {
    "FINOS_NEON_HOST": "ep-quiet-sky-123456.ap-southeast-1.aws.neon.tech",
    "FINOS_DRIVE_FOLDER_ID": "1AbCdEfGh",
}


def test_loads_required_settings_with_defaults():
    settings = load_settings(REQUIRED)

    assert settings.neon_host == REQUIRED["FINOS_NEON_HOST"]
    assert settings.drive_folder_id == "1AbCdEfGh"
    assert settings.ai_budget_usd == Decimal("10")
    assert settings.model_extract == DEFAULT_MODEL
    assert settings.model_categorise == DEFAULT_MODEL


def test_neon_sql_url_swaps_the_endpoint_label_for_api():
    settings = load_settings(REQUIRED)

    assert settings.neon_sql_url == "https://api.ap-southeast-1.aws.neon.tech/sql"


def test_accepts_a_neon_host_with_a_cell_label():
    settings = load_settings(
        REQUIRED | {"FINOS_NEON_HOST": "ep-quiet-sky-123456.c-2.ap-southeast-1.aws.neon.tech"}
    )

    # Neon's own driver swaps only the first label, so the cell label stays.
    assert settings.neon_sql_url == "https://api.c-2.ap-southeast-1.aws.neon.tech/sql"


def test_optional_settings_override_defaults():
    settings = load_settings(
        REQUIRED
        | {
            "FINOS_AI_BUDGET_USD": "25.50",
            "FINOS_MODEL_EXTRACT": "claude-sonnet-5-5",
            "FINOS_MODEL_CATEGORISE": "claude-haiku-5-5",
        }
    )

    assert settings.ai_budget_usd == Decimal("25.50")
    assert settings.model_extract == "claude-sonnet-5-5"
    assert settings.model_categorise == "claude-haiku-5-5"


def test_missing_settings_are_all_named():
    with pytest.raises(ConfigError) as error:
        load_settings({})

    assert "FINOS_NEON_HOST" in str(error.value)
    assert "FINOS_DRIVE_FOLDER_ID" in str(error.value)


@pytest.mark.parametrize(
    "value",
    [
        "postgresql://user:hunter2@ep-quiet-sky-123456.ap-southeast-1.aws.neon.tech/finos",
        "user:hunter2@ep-quiet-sky-123456.ap-southeast-1.aws.neon.tech",
    ],
)
def test_rejects_a_connection_string_without_echoing_it(value):
    with pytest.raises(ConfigError) as error:
        load_settings(REQUIRED | {"FINOS_NEON_HOST": value})

    assert "network secret" in str(error.value)
    assert "hunter2" not in str(error.value)


@pytest.mark.parametrize(
    "value",
    [
        "localhost",
        "ep-a.evil.com/x.aws.neon.tech",
        "ep-a.evil.com?.aws.neon.tech",
        "ep-x.neon.tech",
        "ep-a.x-2.ap-southeast-1.aws.neon.tech",
        "ep-a.c-2.evil.com.aws.neon.tech",
    ],
)
def test_rejects_a_host_that_is_not_a_neon_endpoint(value):
    with pytest.raises(ConfigError):
        load_settings(REQUIRED | {"FINOS_NEON_HOST": value})


def test_rejects_a_budget_that_is_not_a_positive_number():
    with pytest.raises(ConfigError):
        load_settings(REQUIRED | {"FINOS_AI_BUDGET_USD": "lots"})
    with pytest.raises(ConfigError):
        load_settings(REQUIRED | {"FINOS_AI_BUDGET_USD": "-1"})


def test_a_blank_model_setting_falls_back_to_the_default():
    settings = load_settings(REQUIRED | {"FINOS_MODEL_EXTRACT": "  "})

    assert settings.model_extract == DEFAULT_MODEL


def test_the_review_minimum_defaults_to_ten_thousand_rupees_and_can_be_changed():
    assert load_settings(REQUIRED).review_min_inr == Decimal("10000")
    assert load_settings(REQUIRED | {"FINOS_REVIEW_MIN_INR": "2500"}).review_min_inr == 2500
    assert load_settings(REQUIRED | {"FINOS_REVIEW_MIN_INR": "0"}).review_min_inr == 0


@pytest.mark.parametrize("value", ["lots", "-1", "NaN"])
def test_rejects_a_review_minimum_that_is_not_a_number_of_rupees(value):
    with pytest.raises(ConfigError, match="FINOS_REVIEW_MIN_INR"):
        load_settings(REQUIRED | {"FINOS_REVIEW_MIN_INR": value})
