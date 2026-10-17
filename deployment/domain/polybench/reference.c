/* PolyBench/C 4.2.1, 3mm; Copyright (c) 2010-2016, Ohio State University.
 * See LICENSE.txt for the distribution terms.
 * Upstream: https://github.com/MatthiasJReisinger/PolyBenchC-4.2.1
 * Revision: 3e872547cef7e5c9909422ef1e6af03cf4e56072; linear-algebra/kernels/3mm/3mm.c
 * Adaptation: expose the original kernel with runtime C99 dimensions and double arrays.
 * A, B, C, D are immutable inputs; E and F are scratch; G is the complete output.
 */
void kernel_3mm(int ni, int nj, int nk, int nl, int nm,
                double E[ni][nj], const double A[ni][nk], const double B[nk][nj],
                double F[nj][nl], const double C[nj][nm], const double D[nm][nl],
                double G[ni][nl])
{
  int i, j, k;

  /* E := A*B */
  for (i = 0; i < ni; i++)
    for (j = 0; j < nj; j++)
      {
	E[i][j] = 0.0;
	for (k = 0; k < nk; ++k)
	  E[i][j] += A[i][k] * B[k][j];
      }
  /* F := C*D */
  for (i = 0; i < nj; i++)
    for (j = 0; j < nl; j++)
      {
	F[i][j] = 0.0;
	for (k = 0; k < nm; ++k)
	  F[i][j] += C[i][k] * D[k][j];
      }
  /* G := E*F */
  for (i = 0; i < ni; i++)
    for (j = 0; j < nl; j++)
      {
	G[i][j] = 0.0;
	for (k = 0; k < nj; ++k)
	  G[i][j] += E[i][k] * F[k][j];
      }

}
