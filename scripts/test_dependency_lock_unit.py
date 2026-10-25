import unittest
from check_dependencies import check


class DependencyLockTests(unittest.TestCase):
    def test_rejects_upgrade_not_exercised_by_locked_install(self):
        self.assertEqual(
            check("Django>=6.1,<6.2", "Django==5.2.18"),
            ["Django<6.2,>=6.1 conflicts with locked version 5.2.18"],
        )

    def test_normalizes_names_and_handles_extras_and_comments(self):
        self.assertEqual(
            check(
                "# comment\nPsycopg[binary]>=3.2,<4\nmy_package>=1",
                "psycopg==3.3.6\nmy-package==1.2",
            ),
            [],
        )

    def test_requires_missing_and_unpinned_entries_to_be_fixed(self):
        self.assertIn("Missing lock entry: Django", check("Django>=5.2", ""))
        self.assertTrue(check("Django>=5.2", "Django>=5.2"))
