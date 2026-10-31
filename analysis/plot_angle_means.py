"""计算每个 角度(传感器).csv 中 Bx/By/Bz 的均值，并绘制随磁铁角度变化的趋势图。

用法: python analysis/plot_angle_means.py
输出: analysis/output/summary_means.csv, by_sensor.png, by_component.png
"""
import re
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.ticker import AutoMinorLocator, MaxNLocator, MultipleLocator

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "mag_csv_data"
OUT_DIR = Path(__file__).resolve().parent / "output"
NAME_RE = re.compile(r"^(\d+)\((\d)\)\.csv$")
COMPONENTS = ["Bx", "By", "Bz"]

plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False


def fine_ticks(ax) -> None:
    """x 轴每 2° 一个主刻度、1° 一个次刻度；y 轴加密主刻度并加次刻度网格。"""
    ax.xaxis.set_major_locator(MultipleLocator(2))
    ax.xaxis.set_minor_locator(MultipleLocator(1))
    ax.yaxis.set_major_locator(MaxNLocator(nbins=14))
    ax.yaxis.set_minor_locator(AutoMinorLocator(2))
    ax.tick_params(axis="x", which="major", labelsize=8, labelbottom=True)
    ax.tick_params(axis="y", which="major", labelsize=8)
    ax.grid(which="major", alpha=0.35)
    ax.grid(which="minor", alpha=0.12)


def load_summary() -> pd.DataFrame:
    rows = []
    for path in DATA_DIR.glob("*.csv"):
        m = NAME_RE.match(path.name)
        if not m:
            print(f"跳过: {path.name}")
            continue
        df = pd.read_csv(path, usecols=[f"{c}_uT" for c in COMPONENTS])
        # 传感器读取失败时会写入 (-1, -1, -1)，剔除这些无效行
        invalid = (df == -1.0).all(axis=1)
        if invalid.any():
            print(f"{path.name}: 剔除 {invalid.sum()} 行无效数据 (-1,-1,-1)")
        df = df[~invalid]
        row = {"sensor": int(m.group(2)), "angle": int(m.group(1)), "n_samples": len(df)}
        for c in COMPONENTS:
            row[f"{c}_mean"] = df[f"{c}_uT"].mean()
            row[f"{c}_std"] = df[f"{c}_uT"].std()
        bmag = np.sqrt((df ** 2).sum(axis=1))
        row["Bmag_mean"] = bmag.mean()
        row["Bmag_std"] = bmag.std()
        rows.append(row)
    return pd.DataFrame(rows).sort_values(["sensor", "angle"]).reset_index(drop=True)


def plot_by_sensor(summary: pd.DataFrame) -> None:
    sensors = sorted(summary["sensor"].unique())
    fig, axes = plt.subplots(len(sensors), 1, figsize=(14, 4.2 * len(sensors)), sharex=True)
    for ax, s in zip(np.atleast_1d(axes), sensors):
        d = summary[summary["sensor"] == s]
        for c in COMPONENTS:
            ax.errorbar(d["angle"], d[f"{c}_mean"], yerr=d[f"{c}_std"],
                        marker="o", ms=4, capsize=3, label=c)
        ax.set_title(f"传感器 {s}")
        ax.set_ylabel("磁场均值 (µT)")
        fine_ticks(ax)
        ax.legend(loc="best")
    axes[-1].set_xlabel("磁铁角度 (°)")
    fig.suptitle("各传感器 Bx / By / Bz 均值随角度变化（误差棒 = ±1 std）")
    fig.tight_layout()
    fig.savefig(OUT_DIR / "by_sensor.png", dpi=150)
    plt.close(fig)


def plot_by_component(summary: pd.DataFrame) -> None:
    sensors = sorted(summary["sensor"].unique())
    keys = COMPONENTS + ["Bmag"]
    titles = ["Bx", "By", "Bz", "|B| = √(Bx²+By²+Bz²)"]
    fig, axes = plt.subplots(2, 2, figsize=(20, 11), sharex=True)
    for ax, key, title in zip(axes.flat, keys, titles):
        for s in sensors:
            d = summary[summary["sensor"] == s]
            ax.plot(d["angle"], d[f"{key}_mean"], marker="o", ms=4, label=f"传感器 {s}")
        ax.set_title(title)
        ax.set_ylabel("µT")
        fine_ticks(ax)
        ax.legend(loc="best")
    for ax in axes[-1]:
        ax.set_xlabel("磁铁角度 (°)")
    fig.suptitle("三个传感器各分量均值对比")
    fig.tight_layout()
    fig.savefig(OUT_DIR / "by_component.png", dpi=150)
    plt.close(fig)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    summary = load_summary()
    summary.to_csv(OUT_DIR / "summary_means.csv", index=False, float_format="%.3f",
                   encoding="utf-8-sig")
    print(f"文件数: {len(summary)}, 角度数: {summary['angle'].nunique()}, "
          f"传感器数: {summary['sensor'].nunique()}")
    plot_by_sensor(summary)
    plot_by_component(summary)
    print(f"已输出到 {OUT_DIR}")


if __name__ == "__main__":
    main()
