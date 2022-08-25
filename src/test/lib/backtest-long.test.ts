import { expect } from 'chai';
import { DataFrame, IDataFrame } from 'data-forge';
import * as moment from 'dayjs';
import { backtest } from '../../lib/backtest';
import { IBar } from '../../lib/bar';
import { EnterPositionFn, ExitPositionFn, IEntryRuleArgs, IExitRuleArgs, IStrategy, TradeDirection } from '../../lib/strategy';

describe("backtest long", () => {

    function round(value: number) {
        return Math.round(value * 100) / 100;
    }

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

    const mockEntry = () => {};
    const mockExit = () => {};

    function mockStrategy(): IStrategy {
        return { 
            entryRule: mockEntry,
            exitRule: mockExit,
         };
    }

    function unconditionalLongEntry(enterPosition: EnterPositionFn, args: IEntryRuleArgs<IBar, {}>) {
        enterPosition({ direction: TradeDirection.Long }); // Unconditionally enter position at market price.
    };

    function unconditionalLongExit(exitPosition: ExitPositionFn, args: IExitRuleArgs<IBar, {}>) {
        exitPosition(); // Unconditionally exit position at market price.
    };

    const longStrategyWithUnconditionalEntry: IStrategy = {
        entryRule: unconditionalLongEntry,
        exitRule: mockExit,
    };

    const longStrategyWithUnconditionalEntryAndExit: IStrategy = {
        entryRule: unconditionalLongEntry,
        exitRule: unconditionalLongExit,
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
        { time: "2018/10/23", close: 5 },
        { time: "2018/10/24", close: 6 },
    ]);
    
    it('going long makes a profit when the price rises', () => {

        const entryPrice = 3;
        const exitPrice = 7;
        const inputSeries = makeDataSeries([
            { time: "2018/10/20", open: 1, close: 2 },
            { time: "2018/10/21", open: entryPrice, close: 4 }, // Enter position at open on this day.
            { time: "2018/10/22", open: 5, close: 6 },
            { time: "2018/10/23", open: exitPrice, close: 8 }, // Exit position at open on this day.
        ]);

        const trades = backtest(longStrategyWithUnconditionalEntryAndExit, inputSeries);
        const singleTrade = trades[0];
        expect(singleTrade.profit).to.be.greaterThan(0);
        expect(singleTrade.profit).to.eql(exitPrice-entryPrice);
    });

    it('going long makes a loss when the price drops', () => {

        const entryPrice = 6;
        const exitPrice = 2;
        const inputSeries = makeDataSeries([
            { time: "2018/10/20", open: 8, close: 7 },
            { time: "2018/10/21", open: entryPrice, close: 5 }, // Enter position at open on this day.
            { time: "2018/10/22", open: 4, close: 3 }, 
            { time: "2018/10/23", open: exitPrice, close: 1 }, // Exit position at open on this day.
        ]);

        const trades = backtest(longStrategyWithUnconditionalEntryAndExit, inputSeries);
        const singleTrade = trades[0];
        expect(singleTrade.profit).to.be.lessThan(0);
        expect(singleTrade.profit).to.eql(exitPrice-entryPrice);
    });

    it("can exit long via stop loss", () => {
        
        const strategy: IStrategy = {
            entryRule: unconditionalLongEntry,
            stopLoss: args => args.entryPrice * (20/100)
        };

        const inputSeries = makeDataSeries([
            { time: "2018/10/20", close: 100 },
            { time: "2018/10/21", close: 100 }, // Entry day.
            { time: "2018/10/22", close: 90 },  // Hold
            { time: "2018/10/23", close: 70 },  // Stop loss triggered.
            { time: "2018/10/24", close: 70 },
        ]);

        const trades = backtest(strategy, inputSeries);
        expect(trades.length).to.eql(1);

        const singleTrade = trades[0];
        expect(singleTrade.stopPrice).to.eql(80);
        expect(singleTrade.exitReason).to.eql("stop-loss");
        expect(singleTrade.exitTime).to.eql(makeDate("2018/10/23"));
    });

    it("stop loss exits long based on intrabar low", () => {
        
        const strategy: IStrategy = {
            entryRule: unconditionalLongEntry,
            stopLoss: args => args.entryPrice * (20/100)
        };

        const inputSeries = makeDataSeries([
            { time: "2018/10/20", close: 100 },
            { time: "2018/10/21", close: 100 }, // Entry day.
            { time: "2018/10/22", close: 90 },  // Hold
            { time: "2018/10/23", open: 90, high: 100, low: 30, close: 70 },  // Stop loss triggered.
            { time: "2018/10/24", close: 70 },
        ]);

        const trades = backtest(strategy, inputSeries);
        expect(trades.length).to.eql(1);

        const singleTrade = trades[0];
        expect(singleTrade.exitPrice).to.eql(80);
    });

    it("stop loss is not triggered unless there is a significant loss", () => {
        
        const strategy: IStrategy = {
            entryRule: unconditionalLongEntry,
            stopLoss: args => args.entryPrice * (20/100)
        };

        const inputSeries = makeDataSeries([
            { time: "2018/10/20", close: 100 },
            { time: "2018/10/21", close: 100 }, // Entry day
            { time: "2018/10/22", close: 90 },  // Hold
            { time: "2018/10/23", close: 85 },  // Hold
            { time: "2018/10/24", close: 82 },  // Exit
        ]);

        const trades = backtest(strategy, inputSeries);
        expect(trades.length).to.eql(1);

        const singleTrade = trades[0];
        expect(singleTrade.exitReason).to.eql("finalize");
        expect(singleTrade.exitTime).to.eql(makeDate("2018/10/24"));
    });

    it("can exit long via profit target", () => {
        
        const strategy: IStrategy = {
            entryRule: unconditionalLongEntry,
            profitTarget: args => args.entryPrice * (10/100)
        };

        const inputSeries = makeDataSeries([
            { time: "2018/10/20", close: 100 },
            { time: "2018/10/21", close: 100 }, // Entry day.
            { time: "2018/10/22", close: 100 },  // Hold
            { time: "2018/10/23", close: 110 },  // Profit target triggered.
            { time: "2018/10/24", close: 110 },
        ]);

        const trades = backtest(strategy, inputSeries);
        expect(trades.length).to.eql(1);

        const singleTrade = trades[0];
        expect(singleTrade.profitTarget).to.eql(110);
        expect(singleTrade.exitReason).to.eql("profit-target");
        expect(singleTrade.exitTime).to.eql(makeDate("2018/10/23"));
    });

    it("profit target exits long based on intrabar high", () => {
        
        const strategy: IStrategy = {
            entryRule: unconditionalLongEntry,
            profitTarget: args => args.entryPrice * (10/100)
        };

        const inputSeries = makeDataSeries([
            { time: "2018/10/20", close: 100 },
            { time: "2018/10/21", close: 100 }, // Entry day.
            { time: "2018/10/22", close: 90 },  // Hold
            { time: "2018/10/23", open: 90, high: 120, low: 90, close: 90 },  // Profit target triggered.
            { time: "2018/10/24", close: 70 },
        ]);

        const trades = backtest(strategy, inputSeries);
        expect(trades.length).to.eql(1);

        const singleTrade = trades[0];
        expect(singleTrade.exitPrice).to.eql(110);
    });

    it("long exit is not triggered unless target profit is achieved", () => {
        
        const strategy: IStrategy = {
            entryRule: unconditionalLongEntry,
            profitTarget: args => args.entryPrice * (30/100)
        };

        const inputSeries = makeDataSeries([
            { time: "2018/10/20", close: 100 },
            { time: "2018/10/21", close: 100 }, // Entry day
            { time: "2018/10/22", close: 100 },  // Hold
            { time: "2018/10/23", close: 110 },  // Hold
            { time: "2018/10/24", close: 120 },  // Exit
        ]);

        const trades = backtest(strategy, inputSeries);
        expect(trades.length).to.eql(1);

        const singleTrade = trades[0];
        expect(singleTrade.exitReason).to.eql("finalize");
        expect(singleTrade.exitTime).to.eql(makeDate("2018/10/24"));
    });

    it("can exit long via trailing stop loss", () => {
        
        const strategy: IStrategy = {
            entryRule: unconditionalLongEntry,
            trailingStopLoss: args => args.bar.close * (20/100)
        };

        const inputSeries = makeDataSeries([
            { time: "2018/10/20", close: 100 },
            { time: "2018/10/21", close: 100 }, // Entry day.
            { time: "2018/10/22", close: 90 },  // Hold
            { time: "2018/10/23", close: 70 },  // Stop loss triggered.
            { time: "2018/10/24", close: 70 },
        ]);

        const trades = backtest(strategy, inputSeries);
        expect(trades.length).to.eql(1);

        const singleTrade = trades[0];
        expect(singleTrade.exitReason).to.eql("stop-loss");
        expect(singleTrade.exitTime).to.eql(makeDate("2018/10/23"));
    });

    it("can exit long via rising trailing stop loss", () => {
        
        const strategy: IStrategy = {
            entryRule: unconditionalLongEntry,
            trailingStopLoss: args => args.bar.close * (20/100)
        };

        const inputSeries = makeDataSeries([
            { time: "2018/10/20", close: 100 },
            { time: "2018/10/21", close: 100 },  // Entry day.
            { time: "2018/10/22", close: 200 },  // Hold
            { time: "2018/10/23", close: 150 },  // Stop loss triggered.
            { time: "2018/10/24", close: 150 },
        ]);

        const trades = backtest(strategy, inputSeries);
        expect(trades.length).to.eql(1);

        const singleTrade = trades[0];
        expect(singleTrade.exitReason).to.eql("stop-loss");
        expect(singleTrade.exitTime).to.eql(makeDate("2018/10/23"));
    });

    it("trailing stop loss exits long based on intrabar low", () => {
        
        const strategy: IStrategy = {
            entryRule: unconditionalLongEntry,
            trailingStopLoss: args => args.bar.close * (20/100)
        };

        const inputSeries = makeDataSeries([
            { time: "2018/10/20", close: 100 },
            { time: "2018/10/21", close: 100 }, // Entry day.
            { time: "2018/10/22", close: 90 },  // Hold
            { time: "2018/10/23", open: 90, high: 100, low: 30, close: 70 },  // Stop loss triggered.
            { time: "2018/10/24", close: 70 },
        ]);

        const trades = backtest(strategy, inputSeries);
        expect(trades.length).to.eql(1);

        const singleTrade = trades[0];
        expect(singleTrade.exitPrice).to.eql(82);
    });

    it("trailing stop loss is not triggered unless there is a significant loss", () => {
        
        const strategy: IStrategy = {
            entryRule: unconditionalLongEntry,
            trailingStopLoss: args => args.bar.close * (20/100)
        };

        const inputSeries = makeDataSeries([
            { time: "2018/10/20", close: 100 },
            { time: "2018/10/21", close: 100 }, // Entry day
            { time: "2018/10/22", close: 90 },  // Hold
            { time: "2018/10/23", close: 85 },  // Hold
            { time: "2018/10/24", close: 84 },  // Exit
        ]);

        const trades = backtest(strategy, inputSeries);
        expect(trades.length).to.eql(1);

        const singleTrade = trades[0];
        expect(singleTrade.exitReason).to.eql("finalize");
        expect(singleTrade.exitTime).to.eql(makeDate("2018/10/24"));
    });

    it("trailing stop loss does not trigger because profit target is not met", () => {
        
        const strategy: IStrategy = {
            entryRule: unconditionalLongEntry,
            trailingStopLoss: args => {
                // Trigger trailing stop when close is 20% gte entryPrice
                const trailingStopPercent = 2;
                const trailingStopTriggerPercent = 6.5;
                const triggerMinPrice = args.entryPrice * (1 + (trailingStopTriggerPercent/100));

                if (args.position.maxPriceRecorded >= triggerMinPrice) {
                    const returnPrice = args.position.maxPriceRecorded * (trailingStopPercent/100);
                    return returnPrice;
                } else {
                    return Infinity;
                }
            }
        };

        const inputSeries = makeDataSeries([
            { time: "2018/10/20", close: 100 },
            { time: "2018/10/21", close: 110 }, // Entry day
            { time: "2018/10/22", close: 100 }, // Hold
            { time: "2018/10/23", close: 90 },  // Hold
            { time: "2018/10/24", close: 82 },  // Final bar Exit
        ]);

        const trades = backtest(strategy, inputSeries);
        expect(trades.length).to.eql(1);

        const singleTrade = trades[0];
        expect(singleTrade.exitReason).to.eql("finalize");
        expect(singleTrade.exitTime).to.eql(makeDate("2018/10/24"));
    });

    it("trailing stop loss is not triggered until profit target is hit", () => {
        
        const strategy: IStrategy = {
            entryRule: unconditionalLongEntry,
            trailingStopLoss: args => {
                const trailingStopPercent = 2;
                const trailingStopTriggerPercent = 6.5;
                const triggerMinPrice = args.entryPrice * (1 + (trailingStopTriggerPercent/100));

                if (args.position.maxPriceRecorded >= triggerMinPrice) {
                    const returnPrice = args.position.maxPriceRecorded * (trailingStopPercent/100);
                    return returnPrice;
                } else {
                    return Infinity;
                }
            }
        };

        // KUCOIN:ARPAUSDT 3MIN 2022-08-20 8:00 - 8:21 
        // const inputSeries = makeDataSeries([
        //     { time: '2022-08-20T14:57:00.000Z', high: 0.036037, low: 0.035787, open: 0.035831, close: 0.036037, volume: 103.1224 },
        //     { time: '2022-08-21T15:00:00.000Z', high: 0.036037, low: 0.035918, open: 0.036037, close: 0.035918, volume: 267.4557 },         // enter
        //     { time: '2022-08-22T15:03:00.000Z', high: 0.038191, low: 0.035918, open: 0.035918, close: 0.038133, volume: 225034.6572 },      // 
        //     { time: '2022-08-23T15:06:00.000Z', high: 0.045429, low: 0.037297, open: 0.037859, close: 0.045429, volume: 2686895.59482497 }, // sets a high of 0.045429
        //     { time: '2022-08-24T15:09:00.000Z', high: 0.051927, low: 0.044323, open: 0.045259, close: 0.044795, volume: 1803062.29824912 }, // exit at 0.04452 which is 2% less then 0.045429
        //     { time: '2022-08-25T15:12:00.000Z', high: 0.046363, low: 0.041235, open: 0.044803, close: 0.041253, volume: 1267479.04375828 },
        //     { time: '2022-08-26T15:15:00.000Z', high: 0.042137, low: 0.039254, open: 0.041504, close: 0.039318, volume: 618008.32226289 },
        //     { time: '2022-08-27T15:18:00.000Z', high: 0.039511, low: 0.038721, open: 0.039411, close: 0.038941, volume: 164376.70768828 },
        // ]);

        const inputSeries = makeDataSeries([
            { time: '2022-08-22T15:03:00.000Z', high: 0.038191, low: 0.035918, open: 0.035918, close: 0.038133, volume: 225034.6572 },      // 
            { time: '2022-08-23T15:06:00.000Z', high: 0.045429, low: 0.037297, open: 0.037859, close: 0.045429, volume: 2686895.59482497 }, // enter, sets high of close 0.045429
            { time: '2022-08-24T15:09:00.000Z', high: 0.051927, low: 0.044323, open: 0.045259, close: 0.044795, volume: 1803062.29824912 }, // sets a high of 0.051927
            { time: '2022-08-25T15:12:00.000Z', high: 0.046363, low: 0.041235, open: 0.044803, close: 0.041253, volume: 1267479.04375828 }, // exits at 0.0438991
            { time: '2022-08-26T15:15:00.000Z', high: 0.042137, low: 0.039254, open: 0.041504, close: 0.039318, volume: 618008.32226289 },
            { time: '2022-08-27T15:18:00.000Z', high: 0.039511, low: 0.038721, open: 0.039411, close: 0.038941, volume: 164376.70768828 },
        ]);

        const trades = backtest(strategy, inputSeries);
        // expect(trades.length).to.eql(1);

        const singleTrade = trades[0];
        expect(singleTrade.exitReason).to.eql("stop-loss");
        // expect(singleTrade.exitPrice).to.eql(117.6);
        // expect(singleTrade.exitTime).to.eql(makeDate("2018/10/26"));
    });

    it("trailing stop loss with traditional stop loss", () => {
        
        const strategy: IStrategy = {
            entryRule: unconditionalLongEntry,
            stopLoss: args => args.entryPrice * (1.5/100),
            trailingStopLoss: args => {
                // Trigger trailing stop when close is 10% gte entryPrice
                const triggerMinPrice = args.entryPrice * (1 + (10/100));
                if (args.bar.close >= triggerMinPrice) {
                    return args.bar.close * (2/100);
                } else {
                    return Infinity;
                }
            }
        };

        const inputSeries = makeDataSeries([
            { time: "2018/10/20", close: 100 },
            { time: "2018/10/21", close: 100 }, // Entry day
            { time: "2018/10/22", close: 98 },  // Exit traditional stop
            { time: "2018/10/23", close: 110 }, 
            { time: "2018/10/24", close: 120 }, // Entry Day
            { time: "2018/10/25", close: 140 }, // Hit profit target
            { time: "2018/10/26", close: 130 }, // Exit at 137.2 
        ]);

        const trades = backtest(strategy, inputSeries);
        expect(trades.length).to.eql(2);
        
        const firstTrade = trades[0];
        expect(firstTrade.exitReason).to.eql("stop-loss");
        expect(firstTrade.exitPrice).to.eql(98.5);
        expect(firstTrade.exitTime).to.eql(makeDate("2018/10/22"));

        const secondTrade = trades[1];
        expect(secondTrade.exitReason).to.eql("stop-loss");
        expect(secondTrade.exitPrice).to.eql(137.2);
        expect(secondTrade.exitTime).to.eql(makeDate("2018/10/26"));
    });
    
    it("can place intrabar conditional long order", () => {
        
        const strategy: IStrategy = {
            entryRule: (enterPosition, args) => {
                enterPosition({ 
                    direction: TradeDirection.Long, 
                    entryPrice: 6, // Enter position when price hits 6.
                }); 
            },

            exitRule: mockExit,
        };

        const inputSeries = makeDataSeries([
            { time: "2018/10/20", close: 1 },
            { time: "2018/10/21", close: 2 },
            { time: "2018/10/22", close: 4 },
            { time: "2018/10/23", close: 5, high: 6 }, // Intraday entry.
            { time: "2018/10/24", close: 5 },
        ]);

        const trades = backtest(strategy, inputSeries);
        expect(trades.length).to.eql(1);

        const singleTrade = trades[0];
        expect(singleTrade.entryTime).to.eql(makeDate("2018/10/23"));
    });
    
    it("conditional long order is not executed if price doesn't reach target", () => {
        
        const strategy: IStrategy = {
            entryRule: (enterPosition, args) => {
                enterPosition({ 
                    direction: TradeDirection.Long, 
                    entryPrice: 6, // Enter position when price hits 6.
                }); 
            },

            exitRule: mockExit,
        };

        const inputSeries = makeDataSeries([
            { time: "2018/10/20", close: 1 },
            { time: "2018/10/21", close: 2 },
            { time: "2018/10/22", close: 3 },
            { time: "2018/10/23", close: 4 },
            { time: "2018/10/24", close: 5 },
        ]);

        const trades = backtest(strategy, inputSeries);
        expect(trades.length).to.eql(0);
    });

    it("computes risk from initial stop", () => {
        
        const strategy: IStrategy = {
            entryRule: unconditionalLongEntry,
            stopLoss: args => args.entryPrice * (20/100)
        };

        const inputSeries = makeDataSeries([
            { time: "2018/10/20", close: 100 },
            { time: "2018/10/21", close: 100 }, // Entry day.
            { time: "2018/10/22", close: 100 },
        ]);

        const trades = backtest(strategy, inputSeries);
        expect(trades.length).to.eql(1);

        const singleTrade = trades[0];
        expect(singleTrade.riskPct).to.eql(20);
    });

    it("computes rmultiple from initial risk and profit", () => {
        
        const strategy: IStrategy = {
            entryRule: unconditionalLongEntry,
            stopLoss: args => args.entryPrice * (20/100)
        };

        const inputSeries = makeDataSeries([
            { time: "2018/10/20", close: 100 },
            { time: "2018/10/21", close: 100 }, // Entry day.
            { time: "2018/10/22", close: 120 },
        ]);

        const trades = backtest(strategy, inputSeries);
        expect(trades.length).to.eql(1);

        const singleTrade = trades[0];
        expect(singleTrade.rmultiple).to.eql(1);
    });

    it("computes rmultiple from initial risk and loss", () => {
        
        const strategy: IStrategy = {
            entryRule: unconditionalLongEntry,
            stopLoss: args => args.entryPrice * (20/100)
        };

        const inputSeries = makeDataSeries([
            { time: "2018/10/20", close: 100 },
            { time: "2018/10/21", close: 100 }, // Entry day.
            { time: "2018/10/22", close: 80 },
        ]);

        const trades = backtest(strategy, inputSeries);
        expect(trades.length).to.eql(1);

        const singleTrade = trades[0];
        expect(singleTrade.rmultiple).to.eql(-1);
    });

    it("current risk rises as profit increases", () => {
        
        const strategy: IStrategy = {
            entryRule: unconditionalLongEntry,
            stopLoss: args => args.entryPrice * (20/100)
        };

        const inputSeries = makeDataSeries([
            { time: "2018/10/20", close: 100 },
            { time: "2018/10/21", close: 100 }, // Entry day.
            { time: "2018/10/22", close: 150 },
            { time: "2018/10/23", close: 140 },
            { time: "2018/10/24", close: 200 },
            { time: "2018/10/25", close: 190 },
            { time: "2018/10/26", close: 250 },
        ]);

        const trades = backtest(strategy, inputSeries, { recordRisk: true });
        expect(trades.length).to.eql(1);

        const singleTrade = trades[0];

        const output = singleTrade.riskSeries!.map(risk => ({ time: risk.time, value: round(risk.value) }));
        expect(output).to.eql([
            {
                time: makeDate("2018/10/21"),
                value: 20,
            },
            {
                time: makeDate("2018/10/22"),
                value: 46.67,
            },
            {
                time: makeDate("2018/10/23"),
                value: 42.86,
            },
            {
                time: makeDate("2018/10/24"),
                value: 60,
            },
            {
                time: makeDate("2018/10/25"),
                value: 57.89,
            },
            {
                time: makeDate("2018/10/26"),
                value: 68,
            },
        ]);
    });

    it("current risk remains low by trailing stop loss", () => {
        
        const strategy: IStrategy = {
            entryRule: unconditionalLongEntry,
            trailingStopLoss: args => args.bar.close * (20/100)
        };

        const inputSeries = makeDataSeries([
            { time: "2018/10/20", close: 100 },
            { time: "2018/10/21", close: 100 }, // Entry day.
            { time: "2018/10/22", close: 150 },
            { time: "2018/10/23", close: 140 },
            { time: "2018/10/24", close: 200 },
            { time: "2018/10/25", close: 190 },
            { time: "2018/10/26", close: 250 },
        ]);

        const trades = backtest(strategy, inputSeries, { recordRisk: true });
        expect(trades.length).to.eql(1);

        const singleTrade = trades[0];

        const output = singleTrade.riskSeries!.map(risk => ({ time: risk.time, value: round(risk.value) }));
        expect(output).to.eql([
            {
                time: makeDate("2018/10/21"),
                value: 20,
            },
            {
                time: makeDate("2018/10/22"),
                value: 20,
            },
            {
                time: makeDate("2018/10/23"),
                value: 14.29,
            },
            {
                time: makeDate("2018/10/24"),
                value: 20,
            },
            {
                time: makeDate("2018/10/25"),
                value: 15.79,
            },
            {
                time: makeDate("2018/10/26"),
                value: 20,
            },
        ]);
    });

    it('profit is computed for long trade finalized at end of the trading period', () => {

        const inputData = makeDataSeries([
            { time: "2018/10/20", close: 5 },
            { time: "2018/10/21", close: 5 },
            { time: "2018/10/22", close: 10 },
        ]);
       
        const trades = backtest(longStrategyWithUnconditionalEntry, inputData);
        const singleTrade = trades[0];
        expect(singleTrade.profit).to.eql(5);
        expect(singleTrade.profitPct).to.eql(100);
        expect(singleTrade.growth).to.eql(2);
    });
});
