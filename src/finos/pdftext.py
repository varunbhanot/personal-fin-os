"""The text layer of an unlocked PDF, read independently of Claude."""

import io

import pdfplumber


def page_texts(pdf: bytes) -> list[str]:
    with pdfplumber.open(io.BytesIO(pdf)) as document:
        return [(page.extract_text() or "").strip() for page in document.pages]
