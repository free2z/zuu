"""Independent reference for the f2z-ai-proto pricing fixtures in this directory.

Regenerate with `python3 reference.py .` from this directory. It shares no
code or units with the Rust implementation: it works in USD with exact
rationals (fractions.Fraction), straight from the formula as written, so the
Rust tests that read these files are checked against a second derivation
rather than against themselves.

Implements the formula exactly as the design states it, in USD with Fractions:
  p = cost_usd*100*(1+m); d = p*k; total = max(min, ceil(p+d))
  provider = ceil(cost) milli, developer = floor(d) milli, platform = rest
"""
import json, math, sys
from fractions import Fraction as F

def price(cost_usd, m_bps, k_bps, min_2z):
    m = F(m_bps, 10000); k = F(k_bps, 10000)
    p = cost_usd * 100 * (1 + m)
    d = p * k
    total_2z = max(min_2z, math.ceil(p + d))
    total = total_2z * 1000
    provider = math.ceil(cost_usd * 100 * 1000)
    developer = math.floor(d * 1000)
    platform = total - provider - developer
    assert platform >= 0
    return dict(total_milli=total, provider_milli=provider, developer_milli=developer, platform_milli=platform)

def usage_cost_usd(u, pr):
    # prices: nUSD per 1M tokens / nUSD per unit
    n = F(1, 10**9)
    return (u["input_tokens"] * F(pr["input_nusd_per_mtok"], 10**6) * n
            + u["cached_input_tokens"] * F(pr["cached_input_nusd_per_mtok"], 10**6) * n
            + u["cache_write_tokens"] * F(pr["cache_write_nusd_per_mtok"], 10**6) * n
            + u["output_tokens"] * F(pr["output_nusd_per_mtok"], 10**6) * n
            + u["images"] * pr["image_nusd"] * n
            + u["tool_calls"] * pr["tool_call_nusd"] * n)

cost_cases = [
  ("worked_example_0pct", "$0.021 of provider cost at 0% margin, no markup: 2.1 2Z rounds once, up, to 3 2Z.", 21_000_000, 0, 0, 1),
  ("single_rounding_with_markup", "$0.021 at 0% margin, 10% developer markup: ceil(2.1 + 0.21) = 3. Rounding p and d separately would give ceil(2.1) + ceil(0.21) = 4.", 21_000_000, 0, 1000, 1),
  ("worked_example_50pct", "$0.021 at the current 50% platform margin: ceil(3.15) = 4 2Z.", 21_000_000, 5000, 0, 1),
  ("exact_whole_2z_not_rounded", "$0.02 at 0% margin is exactly 2 2Z; nothing to round.", 20_000_000, 0, 0, 1),
  ("zero_cost_pays_min_charge", "A call with no billable usage still pays min_charge.", 0, 5000, 0, 1),
  ("zero_cost_zero_min", "No usage and min_charge 0: nothing is charged.", 0, 5000, 0, 0),
  ("tiny_cost_provider_rounds_up", "$0.000001 at 50%: 1 2Z total; the provider split ceil(0.1 milli) = 1 milli, never 0.", 1_000, 5000, 0, 1),
  ("min_charge_dominates", "$0.001 at 50% is 0.15 2Z; min_charge 5 wins.", 1_000_000, 5000, 0, 5),
  ("one_dollar_margin_and_markup", "$1.00 at 50% margin and 20% markup: p = 150, d = 30, total 180 2Z.", 1_000_000_000, 5000, 2000, 1),
  ("developer_floor_fractional", "d = 0.1157409375 2Z floors to 115 milli; provider ceil(1234.57) = 1235 milli.", 12_345_700, 2500, 750, 1),
  ("large_cost_100pct_margin", "$123.456789 at 100% margin, 25% markup.", 123_456_789_000, 10000, 2500, 1),
  ("just_over_a_boundary", "$0.020000001 at 0%: one nano-USD over 2 2Z rounds to 3.", 20_000_001, 0, 0, 1),
]

out_cost = []
for name, note, nusd, m, k, mn in cost_cases:
    exp = price(F(nusd, 10**9), m, k, mn)
    out_cost.append(dict(name=name, note=note,
        input=dict(cost_nusd=nusd, platform_margin_bps=m, dev_markup_bps=k, min_charge_2z=mn),
        expected=exp))

Z = dict(input_tokens=0, cached_input_tokens=0, cache_write_tokens=0, output_tokens=0, reasoning_tokens=0, images=0, tool_calls=0)
P = dict(input_nusd_per_mtok=0, cached_input_nusd_per_mtok=0, cache_write_nusd_per_mtok=0, output_nusd_per_mtok=0, image_nusd=0, tool_call_nusd=0)
usage_cases = [
  ("prompt_cache_mix", "$3/M in, $0.30/M cached, $3.75/M cache write, $15/M out. Cost $0.01335 = 1.335 2Z; at 50% that is 2.0025, which rounds to 3. reasoning_tokens is inside output_tokens and is not priced twice.",
   dict(Z, input_tokens=1200, cached_input_tokens=5000, cache_write_tokens=800, output_tokens=350, reasoning_tokens=100),
   dict(P, input_nusd_per_mtok=3_000_000_000, cached_input_nusd_per_mtok=300_000_000, cache_write_nusd_per_mtok=3_750_000_000, output_nusd_per_mtok=15_000_000_000),
   5000, 0, 1),
  ("sub_nano_usd_cost_is_exact", "$0.0375/M in x 7, $0.15/M out x 3 = 712.5 nano-USD: not a whole nano-USD, carried exactly. cost_nusd_ceil (what settle receives) is 713.",
   dict(Z, input_tokens=7, output_tokens=3),
   dict(P, input_nusd_per_mtok=37_500_000, output_nusd_per_mtok=150_000_000),
   5000, 0, 1),
  ("images_and_tools", "2 images at $0.001, 1 tool call at $0.01, 100 in at $2.50/M, 50 out at $10/M = $0.01275; 50% margin + 10% markup = 2.10375 -> 3 2Z.",
   dict(Z, input_tokens=100, output_tokens=50, images=2, tool_calls=1),
   dict(P, input_nusd_per_mtok=2_500_000_000, output_nusd_per_mtok=10_000_000_000, image_nusd=1_000_000, tool_call_nusd=10_000_000),
   5000, 1000, 1),
  ("worked_example_from_usage", "1,400 output tokens at $15/M = $0.021 at 0% margin -> 3 2Z, the worked example reached from a usage vector.",
   dict(Z, output_tokens=1400),
   dict(P, output_nusd_per_mtok=15_000_000_000),
   0, 0, 1),
]
out_usage = []
for name, note, u, pr, m, k, mn in usage_cases:
    c = usage_cost_usd(u, pr)
    fusd = c * 10**15
    assert fusd.denominator == 1
    exp = price(c, m, k, mn)
    exp_full = dict(cost_femto_usd=int(fusd), cost_nusd_ceil=math.ceil(c * 10**9), **exp)
    out_usage.append(dict(name=name, note=note,
        input=dict(usage=u, prices=pr, platform_margin_bps=m, dev_markup_bps=k, min_charge_2z=mn),
        expected=exp_full))

hdr = ("Shared pricing fixtures for f2z-ai-proto::pricing (Rust), and the Python and SQL "
       "implementations of the same formula. Expected values were computed independently with "
       "exact rationals from the formula as written: p = cost_usd*100*(1+platform_margin), "
       "d = p*dev_markup, total = max(min_charge, ceil(p+d)) whole 2Z; provider = ceil(cost), "
       "developer = floor(d), platform = total - provider - developer, all in milli-2Z. "
       "1 2Z = $0.01 = 10,000,000 nano-USD. Margins are basis points (10000 = 100%).")
d = sys.argv[1]
json.dump(dict(schema=1, description=hdr, input_unit="cost_nusd: nano-USD (integer)", cases=out_cost),
          open(f"{d}/worked_examples.json", "w"), indent=2, ensure_ascii=False)
json.dump(dict(schema=1, description=hdr, input_unit="usage: counts; prices: nano-USD per 1M tokens, or per image / per tool call", cases=out_usage),
          open(f"{d}/from_usage.json", "w"), indent=2, ensure_ascii=False)
for f in ("worked_examples.json","from_usage.json"):
    open(f"{d}/{f}","a").write("\n")
for c in out_cost + out_usage: print(c["name"], c["expected"])
