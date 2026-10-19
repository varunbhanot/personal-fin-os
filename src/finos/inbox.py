"""The statements folder in Google Drive.

Requests go to the Drive REST API. With a network secret for www.googleapis.com, the proxy
authenticates them and no auth headers are needed; otherwise auth() supplies a token made
from the service account key held in Doppler.
"""

import hashlib
import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import urlsplit

import google.auth.exceptions
import httpx
from google.auth.transport.requests import Request
from google.oauth2 import service_account

from finos.errors import ConfigError, DriveError, proxy_refused
from finos.secrets import Secret

DRIVE_API = "https://www.googleapis.com/drive/v3"
DRIVE_READONLY = "https://www.googleapis.com/auth/drive.readonly"
_FOLDER_ID = re.compile(r"^[A-Za-z0-9_-]+$")


@dataclass(frozen=True)
class DriveFile:
    id: str
    name: str
    md5: str


def no_auth() -> dict[str, str]:
    return {}


def service_account_auth(key: Secret) -> Callable[[], dict[str, str]]:
    """Auth headers from a service account key, for when the proxy cannot authenticate Drive.

    Tokens are read-only for Drive, held in memory, and refreshed before they expire.
    """
    try:
        info = json.loads(key.reveal())
        credentials = service_account.Credentials.from_service_account_info(
            info, scopes=[DRIVE_READONLY]
        )
    except (ValueError, KeyError, TypeError):
        raise ConfigError(
            "GDRIVE_SA_JSON in Doppler is not a service account key. Paste the whole JSON key "
            "file Google Cloud gave you."
        ) from None

    token_host = urlsplit(str(info.get("token_uri", ""))).hostname or "oauth2.googleapis.com"

    def headers() -> dict[str, str]:
        if not credentials.valid:
            try:
                credentials.refresh(Request())
            except google.auth.exceptions.TransportError as error:
                # google-auth wraps the requests exception, whose name says what failed.
                cause = error.args[0] if error.args else error
                cause = cause if isinstance(cause, Exception) else error
                raise DriveError(
                    f"Could not reach Google's token service ({type(cause).__name__}). Check "
                    f"that {token_host} is an allowed domain in the cloud environment."
                ) from None
            except google.auth.exceptions.GoogleAuthError as error:
                raise DriveError(
                    "Google refused the service account key in GDRIVE_SA_JSON "
                    f"({type(error).__name__}). It may have been deleted or disabled."
                ) from None
        return {"Authorization": f"Bearer {credentials.token}"}

    return headers


class Drive:
    def __init__(
        self,
        client: httpx.Client,
        folder_id: str,
        auth: Callable[[], dict[str, str]] = no_auth,
    ) -> None:
        if not _FOLDER_ID.match(folder_id):
            raise ConfigError("FINOS_DRIVE_FOLDER_ID should be a Drive folder ID, e.g. 1AbCdEfGh")
        self.client = client
        self.folder_id = folder_id
        self.auth = auth

    def list_pdfs(self) -> list[DriveFile]:
        query = (
            f"'{self.folder_id}' in parents and mimeType = 'application/pdf' and trashed = false"
        )
        files: list[DriveFile] = []
        page_token: str | None = None
        while True:
            params = {
                "q": query,
                "fields": "nextPageToken, files(id, name, md5Checksum)",
                "pageSize": "100",
                "orderBy": "name",
            }
            if page_token:
                params["pageToken"] = page_token
            body = self._get(f"{DRIVE_API}/files", params).json()
            files += [
                DriveFile(id=f["id"], name=f["name"], md5=f["md5Checksum"])
                for f in body.get("files", [])
            ]
            page_token = body.get("nextPageToken")
            if not page_token:
                return files

    def download(self, file: DriveFile) -> bytes:
        content = self._get(f"{DRIVE_API}/files/{file.id}", {"alt": "media"}).content
        if hashlib.md5(content).hexdigest() != file.md5:  # noqa: S324 - Drive's checksum
            raise DriveError(f"{file.name} did not download intact; try again")
        return content

    def _get(self, url: str, params: dict[str, str]) -> httpx.Response:
        try:
            response = self.client.get(url, params=params, headers=self.auth())
        except httpx.ProxyError as error:
            raise DriveError(proxy_refused(httpx.URL(url).host, error)) from None
        except httpx.HTTPError as error:
            raise DriveError(f"Could not reach Google Drive: {type(error).__name__}") from None
        if response.status_code in (401, 403, 404):
            raise DriveError(
                f"Google Drive refused access (HTTP {response.status_code}). Check that the "
                "statements folder is shared with the service account, and that the "
                "environment's network secret for www.googleapis.com (or GDRIVE_SA_JSON in "
                "Doppler) holds that service account's key."
            )
        if response.status_code != 200:
            raise DriveError(f"Google Drive returned HTTP {response.status_code}")
        return response
