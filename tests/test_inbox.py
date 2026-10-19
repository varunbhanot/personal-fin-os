import hashlib
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from finos.errors import ConfigError, DriveError
from finos.inbox import Drive, DriveFile

FOLDER = "1AbC-d_E"
PDF = b"%PDF-1.7 statement bytes"
MD5 = hashlib.md5(PDF).hexdigest()  # noqa: S324 - Drive's checksum, not security


def fake_drive(pages: list[list[dict]], seen: list[httpx.Request], content: bytes = PDF):
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.params.get("alt") == "media":
            return httpx.Response(200, content=content)
        token = request.url.params.get("pageToken")
        index = int(token) if token else 0
        body: dict = {"files": pages[index]}
        if index + 1 < len(pages):
            body["nextPageToken"] = str(index + 1)
        return httpx.Response(200, json=body)

    return httpx.Client(transport=httpx.MockTransport(handler))


def file_json(id: str, name: str, md5: str = MD5) -> dict:
    return {"id": id, "name": name, "md5Checksum": md5, "size": str(len(PDF))}


def test_lists_pdfs_across_pages_without_credentials():
    seen: list[httpx.Request] = []
    pages = [[file_json("a", "jan.pdf")], [file_json("b", "feb.pdf")]]

    files = Drive(fake_drive(pages, seen), FOLDER).list_pdfs()

    assert files == [
        DriveFile(id="a", name="jan.pdf", md5=MD5),
        DriveFile(id="b", name="feb.pdf", md5=MD5),
    ]
    query = parse_qs(urlsplit(str(seen[0].url)).query)["q"][0]
    assert f"'{FOLDER}' in parents" in query
    assert "mimeType = 'application/pdf'" in query
    assert "trashed = false" in query
    assert "authorization" not in seen[0].headers


def test_auth_headers_are_added_when_given():
    seen: list[httpx.Request] = []

    Drive(fake_drive([[]], seen), FOLDER, auth=lambda: {"Authorization": "Bearer t"}).list_pdfs()

    assert seen[0].headers["authorization"] == "Bearer t"


def test_download_checks_the_checksum():
    seen: list[httpx.Request] = []
    drive = Drive(fake_drive([[]], seen), FOLDER)

    assert drive.download(DriveFile(id="a", name="jan.pdf", md5=MD5)) == PDF
    with pytest.raises(DriveError, match="jan.pdf"):
        drive.download(DriveFile(id="a", name="jan.pdf", md5="0" * 32))


@pytest.mark.parametrize("status", [401, 403, 404])
def test_access_problems_explain_what_to_check(status):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"error": {"message": "nope"}})

    drive = Drive(httpx.Client(transport=httpx.MockTransport(handler)), FOLDER)

    with pytest.raises(DriveError) as error:
        drive.list_pdfs()

    assert "shared" in str(error.value)


def test_a_proxy_refusal_names_the_host_to_allow():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ProxyError("403 Forbidden http://user:proxy-token@proxy")

    drive = Drive(httpx.Client(transport=httpx.MockTransport(handler)), FOLDER)

    with pytest.raises(DriveError) as error:
        drive.list_pdfs()

    assert "www.googleapis.com" in str(error.value)
    assert "allowed domain" in str(error.value)
    assert "proxy-token" not in str(error.value)


def test_a_folder_id_with_odd_characters_is_rejected():
    with pytest.raises(ConfigError):
        Drive(httpx.Client(), "abc' or '1'='1")
