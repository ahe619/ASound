"""Regression checks for dictionary coverage, using disposable app fixtures."""

import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

from tools.check_i18n import check_app, main


class I18nCheckTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.app = Path(temporary.name)
        (self.app / "js").mkdir()
        (self.app / "locales" / "feat").mkdir(parents=True)
        (self.app / "index.html").write_text('<p data-i18n="app.title"></p>', encoding="utf-8")
        (self.app / "js" / "main.js").write_text('t("app.title"); t("retell.start");', encoding="utf-8")
        self.write_json("en.json", {"app.title": "App"})
        self.write_json("zh.json", {"app.title": "应用"})
        self.write_json("feat/retell.json", {"en": {"retell.start": "Start"}, "zh": {"retell.start": "开始"}})

    def write_json(self, name, data):
        (self.app / "locales" / name).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def test_feature_keys_are_available_without_copying_to_main_locales(self):
        report = check_app(self.app)
        self.assertEqual([], report.problems)
        self.assertEqual(2, report.locale_count)
        self.assertEqual(1, report.feature_count)

    def test_missing_static_key_is_an_error(self):
        (self.app / "js" / "main.js").write_text("t('missing.label')", encoding="utf-8")
        report = check_app(self.app)
        self.assertIn("en: missing missing.label", report.problems)
        self.assertIn("zh: missing missing.label", report.problems)

    def test_feature_parity_checks_unused_keys_too(self):
        self.write_json("feat/retell.json", {"en": {"retell.start": "Start", "retell.other": "Other"}, "zh": {"retell.start": "开始"}})
        self.assertIn("feat/retell.json: retell.other missing from zh", check_app(self.app).problems)

    def test_main_locale_parity_is_not_hidden_by_feature_translation(self):
        self.write_json("en.json", {"app.title": "App", "retell.start": "Start"})
        self.assertIn("main locales: retell.start missing from zh", check_app(self.app).problems)

    def test_optional_locale_can_use_english_fallback(self):
        self.write_json("fr.json", {})
        self.assertEqual([], check_app(self.app).problems)

    def test_optional_locale_still_must_parse(self):
        (self.app / "locales" / "fr.json").write_text("{broken", encoding="utf-8")
        self.assertTrue(any("fr.json: cannot read JSON" in p for p in check_app(self.app).problems))

    def test_non_text_translation_is_rejected(self):
        self.write_json("fr.json", {"app.title": ["bad"]})
        self.assertIn("fr.json: app.title must contain a string", check_app(self.app).problems)

    def test_valid_json_with_non_dictionary_root_is_rejected(self):
        self.write_json("fr.json", None)
        self.write_json("feat/retell.json", None)
        problems = check_app(self.app).problems
        self.assertIn("fr.json: expected a dictionary of text keys", problems)
        self.assertIn("feat/retell.json: expected language dictionaries", problems)

    def test_feature_requires_chinese_dictionary(self):
        self.write_json("feat/retell.json", {"en": {"retell.start": "Start"}})
        self.assertIn("feat/retell.json: required zh dictionary is missing", check_app(self.app).problems)

    def test_required_main_locale_cannot_be_replaced_by_feature_file(self):
        (self.app / "locales" / "zh.json").unlink()
        self.assertIn("zh.json: required locale file is missing", check_app(self.app).problems)

    def test_html_aria_and_placeholder_keys_are_checked(self):
        (self.app / "index.html").write_text("<input data-i18n-label='aria.label' data-i18n-placeholder=\"input.hint\">", encoding="utf-8")
        report = check_app(self.app)
        self.assertIn("en: missing aria.label", report.problems)
        self.assertIn("zh: missing input.hint", report.problems)

    def test_templates_are_reported_without_claiming_to_check_them(self):
        (self.app / "js" / "main.js").write_text('t(`scene.${id}.title`)', encoding="utf-8")
        report = check_app(self.app)
        self.assertEqual([], report.problems)
        self.assertEqual([("main.js", "scene.${id}.title")], report.templates)

    def test_cli_status_fails_for_bad_dictionary(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(0, main(["--app", str(self.app)]))
            self.write_json("zh.json", {})
            self.assertEqual(1, main(["--app", str(self.app)]))


if __name__ == "__main__":
    unittest.main()
