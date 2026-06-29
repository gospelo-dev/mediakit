# MIT License

Copyright (c) 2026 gospelo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## Third-party dependency: FFmpeg

This software does NOT bundle or distribute FFmpeg. At runtime it invokes the
separately-installed `ffmpeg` / `ffprobe` executables as external subprocesses;
the user is responsible for installing FFmpeg and complying with its license.

FFmpeg is a separate project licensed under the GNU Lesser General Public
License (LGPL) version 2.1 or later, with some optional components under the GNU
General Public License (GPL). Depending on how your FFmpeg build was compiled and
configured, additional license terms may apply to that binary. FFmpeg is a
trademark of Fabrice Bellard. See https://ffmpeg.org/legal.html for details.

The MIT license above applies only to the gospelo-mediakit source code in this
repository, not to FFmpeg.
