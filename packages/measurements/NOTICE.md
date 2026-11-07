# Third-party notice

The K-weighting coefficient generation, direct-form II transposed filtering and
400 ms/75% block gating in `src/loudness.ts` are a TypeScript translation of the
installed `pyloudnorm` 0.2.0 implementation (`pyloudnorm/iirfilter.py` and
`pyloudnorm/meter.py`). They are reproduced here only to match the repository's
reference measurements; they are not an independent ITU-R BS.1770 meter
certification.

Upstream: https://github.com/csteinmetz1/pyloudnorm

MIT License

Copyright (c) 2018 Christian Steinmetz

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
