## $\LaTeX$ support via remark-math and rehype-katex

I'm pleased to announce support for $\LaTeX$ via [remark-math and rehype-katex](https://github.com/remarkjs/remark-math).

Here are some examples of what you can do.

### Inline math

To highlight some bit of math, you can wrap the text with `$` 
as in:

```latex
> Some text and some math: $z_{0}, z_{1}, ... z_{n}$
```

> Some text and some math: $z_{0}, z_{1}, ... z_{n}$


### Display Math

You can also set off a whole equation with blank lines and `$$`.
So, for instance, the following code:

```latex
$$
\int_{0}^{n} x^{2}dx
$$  
```

$$
\int_{0}^{n} x^{2}dx
$$

You can also put display math in a block quote with `>`. So:

```md
> Check this out!
> $$
> \int_{1}^{\infty} \frac{dx}{x^2} = 1
> $$
```

> Check this out!
> $$
> \int_{1}^{\infty} \frac{dx}{x^2} = 1
> $$


### Conclusion

$\LaTeX$ is powerful and can help you create
beautifully typeset writing.
I'm excited to see what people do with it
on free2z! Here are some helpful resources
to get started if you are new.

- [List of symbols you can use](https://oeis.org/wiki/List_of_LaTeX_mathematical_symbols)

- [Quickguide/cheatsheet](https://www.library.caltech.edu/sites/default/files/latex-quickguide.pdf) (PDF)


---

> Zero-Knowledge Proofs (ZKP) are used to show the
> verifier that some secret $x$ belongs to some set $L$
> without providing any information about $x$ except the
> correctness[5]. Let $L$ be an $NP$ language defined as
> $L = \{ x | g^{n} = x\}$ it follows three properties of zero
> knowledge proofs as:
> 1. Completeness: Verifier will be convinced by
>    the prover only if statement $x \in L$.
> 2. Soundness: A prover cannot prove an honest
>    verifier if the statement $x \notin L$.
> 3. Zero-Knowledge: If the verifier is convinced
>    that $x \in L$ is correct, even though he will not
>    gain any additional information about the
>    secret.
>
> - From a [cool paper by Nomana Ayesha Majeed](https://monami.hs-mittweida.de/frontdoor/deliver/index/docId/11863/file/Druckfreigabe_Majeed_paper.pdf) (PDF)