"""CLI tool wrappers.

Each module exposes a ``main()`` that parses argv, calls a
``gospelo_mediakit.core`` function, and prints the result as JSON. They are
reachable both as ``gospelo-mediakit <subcommand>`` (via ``cli.py``) and as
``python -m gospelo_mediakit.tools.<name>``.
"""
