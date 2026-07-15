import { usageBars } from "@/lib/demo-data";

export function UsageChart() {
  return (
    <div className="chart-wrap" aria-label="Grafik request AI 14 hari">
      <div className="chart-y"><span>1.2k</span><span>800</span><span>400</span><span>0</span></div>
      <div className="chart-bars">
        {usageBars.map((height, index) => <span key={index} className={index === usageBars.length - 1 ? "chart-bar current" : "chart-bar"} style={{ height: `${height}%` }} title={`${Math.round(height * 12)} requests`} />)}
      </div>
      <div className="chart-x"><span>29 Jun</span><span>5 Jul</span><span>12 Jul</span></div>
    </div>
  );
}
