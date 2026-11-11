"""Final reproducible test specimen for the Tavotto adapter."""
from pathlib import Path
import matplotlib.pyplot as plt
import numpy as np

OUT = Path(__file__).resolve().parent


def main():
    with plt.rc_context({"font.family": "Arial", "font.size": 9, "axes.labelweight": "bold", "axes.linewidth": .75, "xtick.direction": "in", "ytick.direction": "in", "legend.frameon": False}):
        fig, ax = plt.subplots(figsize=(15 / 2.54, 8 / 2.54))
        x = np.array([0, 7, 14, 21])
        line, = ax.plot(x, [10, 12, 14, 16], marker="o", lw=1.0, label="Synthetic response")
        line.set_gid("synthetic_response")
        ax.set_xlabel("Time (day)")
        ax.set_ylabel("Response (a.u.)")
        ax.legend(loc="upper left")
        fig.tight_layout()
        fig.savefig(OUT / "Figure1.pdf")
        fig.savefig(OUT / "Figure1.png", dpi=240)
        plt.close(fig)


if __name__ == "__main__":
    main()
