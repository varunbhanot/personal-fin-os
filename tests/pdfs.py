"""Builds small, real PDFs with text on them, optionally password-protected."""

import io

import pikepdf


def make_pdf(pages: list[list[str]], password: str | None = None) -> bytes:
    pdf = pikepdf.new()
    font = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica
        )
    )
    for lines in pages:
        commands = ["BT", "/F1 10 Tf", "14 TL", "40 800 Td"]
        for line in lines:
            escaped = line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
            commands.append(f"({escaped}) Tj T*")
        commands.append("ET")
        page = pikepdf.Page(
            pikepdf.Dictionary(
                Type=pikepdf.Name.Page,
                MediaBox=[0, 0, 595, 842],
                Resources=pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font)),
                Contents=pdf.make_stream("\n".join(commands).encode("latin-1")),
            )
        )
        pdf.pages.append(page)
    out = io.BytesIO()
    if password is None:
        pdf.save(out)
    else:
        pdf.save(out, encryption=pikepdf.Encryption(user=password, owner=password + "-owner"))
    return out.getvalue()
