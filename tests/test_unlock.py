import io

import pikepdf
import pytest

from finos.errors import BadPdf, WrongPassword
from finos.pdftext import page_texts
from finos.secrets import Secret
from finos.unlock import unlock

from .pdfs import make_pdf

PASSWORDS = {
    "PW_AXIS_BANK": Secret("test-pw-axis"),
    "PW_HDFC_TATANEU": Secret("test-pw-hdfc"),
    "PW_SBI_CARD": Secret("test-pw-sbicard"),
}


def test_an_unprotected_pdf_passes_through():
    pdf = make_pdf([["Statement"]])

    unlocked = unlock(pdf, PASSWORDS, name="plain.pdf")

    assert unlocked.password_name is None
    assert page_texts(unlocked.pdf) == ["Statement"]


def test_the_right_password_is_found_and_the_result_is_unprotected():
    pdf = make_pdf([["HDFC Bank Tata Neu"]], password="test-pw-hdfc")

    unlocked = unlock(pdf, PASSWORDS, name="hdfc.pdf")

    assert unlocked.password_name == "PW_HDFC_TATANEU"
    with pikepdf.open(io.BytesIO(unlocked.pdf)) as reopened:
        assert not reopened.is_encrypted
    assert page_texts(unlocked.pdf) == ["HDFC Bank Tata Neu"]


def test_no_matching_password_is_reported_without_revealing_any():
    pdf = make_pdf([["Canara"]], password="something-else")

    with pytest.raises(WrongPassword) as error:
        unlock(pdf, PASSWORDS, name="canara.pdf")

    message = str(error.value)
    assert "canara.pdf" in message
    assert "3" in message
    for secret in PASSWORDS.values():
        assert secret.reveal() not in message


def test_a_damaged_file_is_reported():
    with pytest.raises(BadPdf, match="broken.pdf"):
        unlock(b"%PDF-1.7 not really", PASSWORDS, name="broken.pdf")


def test_page_texts_keeps_pages_apart():
    pdf = make_pdf([["page one"], ["page two", "second line"]])

    assert page_texts(pdf) == ["page one", "page two\nsecond line"]
