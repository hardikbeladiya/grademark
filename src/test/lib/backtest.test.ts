import { assert, expect } from 'chai';
import { backtest } from '../../lib/backtest';
import { DataFrame, IDataFrame } from 'data-forge';
import { IBar } from '../../lib/bar';
import { IStrategy, EnterPositionFn } from '../../lib/strategy';
import * as moment from 'moment';

describe("backtest", () => {

    function makeDate(dateStr: string, fmt?: string): Date {
        return moment(dateStr, fmt || "YYYY/MM/DD").toDate();
    }

    function mockBar(): IBarDef {
        return {
            time: "2018/10/20",
            close: 2,
        };        
    }

    interface IBarDef {
        time: string;
        open?: number;
        high?: number;
        low?: number;
        close: number;
        volume?: number;
    }

    function makeBar(bar: IBarDef): IBar {
        return {
            time: makeDate(bar.time),
            open: bar.open !== undefined ? bar.open : bar.close,
            high: bar.high !== undefined ? bar.high : bar.close,
            low: bar.low !== undefined ? bar.low : bar.close,
            close: bar.close,
            volume: bar.volume !== undefined ? bar.volume : 1,
        };
    }

    function makeDataSeries(bars: IBarDef[]): IDataFrame<number, IBar> {
        return new DataFrame<number, IBar>(bars.map(makeBar));
    }

    const mockExit = () => {};

    function mockStrategy(): IStrategy {
        return { 
            entryRule: () => {},
            exitRule: mockExit,
         };
    }

    function unconditionalEntry(bar: IBar, dataSeries: IDataFrame<number, IBar>, enterPosition: EnterPositionFn) {
        enterPosition(); // Unconditionally enter position at market price.
    };

    const strategyWithUnconditionalEntry: IStrategy = {
        entryRule: unconditionalEntry,
        exitRule: mockExit,
    };

    const simpleInputSeries = makeDataSeries([
        { time: "2018/10/20", close: 1 },
        { time: "2018/10/21", close: 2 },
        { time: "2018/10/22", close: 3 },
    ]);

    const longerDataSeries = makeDataSeries([
        { time: "2018/10/20", close: 1 },
        { time: "2018/10/21", close: 2 },
        { time: "2018/10/22", close: 4 },
        { time: "2018/10/22", close: 5 },
        { time: "2018/10/22", close: 6 },
    ]);
    
    it("generates no trades when no entry is ever taken", ()  => {

        const trades = backtest(mockStrategy(), makeDataSeries([mockBar()]));
        expect(trades.count()).to.eql(0);
    });

    it("must pass in 1 or more bars", () => {

        expect(() => backtest(mockStrategy(), new DataFrame<number, IBar>())).to.throw();
    });

    it('unconditional entry rule with no exit creates single trade', () => {

        const trades = backtest(strategyWithUnconditionalEntry, simpleInputSeries);
        expect(trades.count()).to.eql(1);
    });
    
    it('unconditional entry rule enters position on day after signal', () => {

        const trades = backtest(strategyWithUnconditionalEntry, simpleInputSeries);
        const singleTrade = trades.first();
        expect(singleTrade.entryTime).to.eql(makeDate("2018/10/21"));
    });

    it('enters position at open on day after signal', () => {

        const trades = backtest(strategyWithUnconditionalEntry, simpleInputSeries);
        const singleTrade = trades.first();
        expect(singleTrade.entryPrice).to.eql(2);
    });

    it('unconditional entry rule creates single trade that is finalized at end of trading period', () => {

        const trades = backtest(strategyWithUnconditionalEntry, simpleInputSeries);
        expect(trades.count()).to.eql(1);
        
        const singleTrade = trades.first();
        expect(singleTrade.exitTime).to.eql(makeDate("2018/10/22"));
    });

    it('open position is finalized on the last day of the trading period', () => {

        const trades = backtest(strategyWithUnconditionalEntry, simpleInputSeries);
        const singleTrade = trades.first();
        expect(singleTrade.exitTime).to.eql(makeDate("2018/10/22"));
    });
    
    it('open position is finalized at end of trading period at the closing price', () => {

        const trades = backtest(strategyWithUnconditionalEntry, simpleInputSeries);
        const singleTrade = trades.first();
        expect(singleTrade.exitPrice).to.eql(3);
    });

    it('profit is computed for trade finalized at end of the trading period', () => {

        const inputData = makeDataSeries([
            { time: "2018/10/20", close: 5 },
            { time: "2018/10/21", close: 5 },
            { time: "2018/10/22", close: 10 },
        ]);
       
        const trades = backtest(strategyWithUnconditionalEntry, inputData);
        const singleTrade = trades.first();
        expect(singleTrade.profit).to.eql(5);
        expect(singleTrade.profitPct).to.eql(100);
        expect(singleTrade.growth).to.eql(2);
    });

    it("conditional entry can be triggered within the trading period", () => {
        
        const strategy: IStrategy = {
            entryRule: (bar, dataSeries, enterPosition) => {
                if (bar.close > 3) {
                    enterPosition(); // Conditional enter when instrument closes above 3.
                }
            },

            exitRule: mockExit,
        };

        const trades = backtest(strategy, longerDataSeries);
        expect(trades.count()).to.eql(1);

        const singleTrade = trades.first();
        expect(singleTrade.entryTime).to.eql(makeDate("2018/10/22"));
        expect(singleTrade.entryPrice).to.eql(5);
    });

    it("conditional entry is not triggered when condition is not met", () => {
        
        const strategy: IStrategy = {
            entryRule: (bar, dataSeries, enterPosition) => {
                if (bar.close > 10) {
                    enterPosition(); // Conditional enter when instrument closes above 3.
                }
            },

            exitRule: mockExit,
        };

        const trades = backtest(strategy, longerDataSeries);
        expect(trades.count()).to.eql(0);
    });

    it("can conditionally exit before end of trading period", () => {
        
        const strategy: IStrategy = {
            entryRule: unconditionalEntry,

            exitRule: (position, bar, dataSeries, exitPosition) => {
                if (bar.close > 3) {
                    exitPosition(); // Exit at next open.
                }
            },
        };

        const trades = backtest(strategy, longerDataSeries);
        expect(trades.count()).to.eql(1);

        const singleTrade = trades.first();
        expect(singleTrade.exitTime).to.eql(makeDate("2018/10/22"));
        expect(singleTrade.exitPrice).to.eql(5);
    });

    it("profit is computed for conditionally exited position", () => {
        
        const strategy: IStrategy = {
            entryRule: unconditionalEntry,
            exitRule: (position, bar, dataSeries, exitPosition) => {
                if (bar.close > 3) {
                    exitPosition(); // Exit at next open.
                }
            },
        };

        const inputData = makeDataSeries([
            { time: "2018/10/20", close: 1 },
            { time: "2018/10/21", close: 5},   // Unconditionally enter here.
            { time: "2018/10/22", close: 6 },   // Exit signal.
            { time: "2018/10/23", close: 10 },  // Exit.
            { time: "2018/10/24", close: 100 }, // Last bar.
        ]);

        const trades = backtest(strategy, inputData);
        expect(trades.count()).to.eql(1);

        const singleTrade = trades.first();
        expect(singleTrade.exitTime).to.eql(makeDate("2018/10/23"));
        expect(singleTrade.profit).to.eql(5);
        expect(singleTrade.profitPct).to.eql(100);
        expect(singleTrade.growth).to.eql(2);
    });
});
