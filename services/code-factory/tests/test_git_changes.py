from code_factory.git_changes import affects_code_factory


def test_code_factory_change_detection() -> None:
    assert affects_code_factory(["services/code-factory/src/code_factory/app.py"])
    assert affects_code_factory(["deploy/macmini/com.jarvis.code-factory.plist"])
    assert not affects_code_factory(["apps/api/src/jarvis_api/main.py"])
