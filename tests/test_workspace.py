from fastapi.testclient import TestClient

from ai_workspace.main import app


def test_workspace_and_assets_are_served_without_authentication() -> None:
    with TestClient(app) as client:
        response = client.get("/")
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/html")
        assert '<html lang="zh-CN">' in response.text
        for name in ["app.js", "api.js", "styles.css", "favicon.svg"]:
            asset = client.get(f"/static/{name}")
            assert asset.status_code == 200
            assert asset.content
        assert client.get("/static/../core/config.py").status_code == 404


def test_workspace_does_not_shadow_existing_api_routes() -> None:
    with TestClient(app) as client:
        assert client.get("/health").json() == {"status": "ok"}
        assert client.get("/conversations").status_code == 401
        paths = client.get("/openapi.json").json()["paths"]
        assert "/conversations/{conversation_id}" in paths
        assert "/conversations/{conversation_id}/messages" not in paths
        assert "/" not in paths
