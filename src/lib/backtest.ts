import { assert } from "chai";
import { IDataFrame } from 'data-forge';
import { IBar, IPosition, IStrategy } from "..";
import { PositionManager } from "./position-manager";
import { IEnterPositionOptions, TradeDirection } from "./strategy";
import { ITrade } from "./trade";
import { isObject } from "./utils";
const CBuffer = require('CBuffer');

/**
 * Update an open position for a new bar.
 * 
 * @param position The position to update.
 * @param bar The current bar.
 */
function updatePosition(position: IPosition, bar: IBar): void {
    position.profit = bar.close - position.entryPrice;
    position.profitPct = (position.profit / position.entryPrice) * 100;
    position.growth = position.direction === TradeDirection.Long
        ? bar.close / position.entryPrice
        : position.entryPrice / bar.close;
    if (position.curStopPrice !== undefined) {
        const unitRisk = position.direction === TradeDirection.Long
            ? bar.close - position.curStopPrice
            : position.curStopPrice - bar.close;
        position.curRiskPct = (unitRisk / bar.close) * 100;
        position.curRMultiple = position.profit / unitRisk;
    }
    position.holdingPeriod += 1;
}

/**
 * Close a position that has been exited and produce a trade.
 * 
 * @param position The position to close.
 * @param exitTime The timestamp for the bar when the position was exited.
 * @param exitPrice The price of the instrument when the position was exited.
 */
function finalizePosition(position: IPosition, exitTime: Date, exitPrice: number, exitReason: string): ITrade {
    const profit = position.direction === TradeDirection.Long 
        ? exitPrice - position.entryPrice
        : position.entryPrice - exitPrice;
    let rmultiple;
    if (position.initialUnitRisk !== undefined) {
        rmultiple = profit / position.initialUnitRisk; 
    }
    return {
        direction: position.direction,
        entryTime: position.entryTime,
        entryPrice: position.entryPrice,
        exitTime: exitTime,
        exitPrice: exitPrice,
        profit: profit,
        profitPct: (profit / position.entryPrice) * 100,
        growth: position.direction === TradeDirection.Long
            ? exitPrice / position.entryPrice
            : position.entryPrice / exitPrice,
        riskPct: position.initialRiskPct,
        riskSeries: position.riskSeries,
        rmultiple: rmultiple,
        holdingPeriod: position.holdingPeriod,
        exitReason: exitReason,
        stopPrice: position.initialStopPrice,
        stopPriceSeries: position.stopPriceSeries,
        profitTarget: position.profitTarget,
    };
}

enum PositionStatus { // Tracks the state of the position across the trading period.
    None,
    Enter,
    Position,
    Exit,
}

/**
 * Options to the backtest function.
 */
export interface IBacktestOptions {
    /**
     * Enable recording of the stop price over the holding period of each trade.
     * It can be useful to enable this and visualize the stop loss over time.
     */
    recordStopPrice?: boolean;

    /**
     * Enable recording of the risk over the holding period of each trade.
     * It can be useful to enable this and visualize the risk over time.
     */
    recordRisk?: boolean;
}

/**
 * Backtest a trading strategy against a data series and generate a sequence of trades.
 */
export function backtest<InputBarT extends IBar, IndicatorBarT extends InputBarT, ParametersT, IndexT>(
    strategy: IStrategy<InputBarT, IndicatorBarT, ParametersT, IndexT>, 
    inputSeries: IDataFrame<IndexT, InputBarT>,
    options?: IBacktestOptions): 
    ITrade[] {

    if (!isObject(strategy)) {
        throw new Error("Expected 'strategy' argument to 'backtest' to be an object that defines the trading strategy to backtest.");
    }

    if (!isObject(inputSeries) && inputSeries.count() > 0) {
        throw new Error("Expected 'inputSeries' argument to 'backtest' to be a Data-Forge DataFrame that contains historical input data for backtesting.");
    }

    if (!options) {
        options = {};
    }

    if (inputSeries.none()) {
        throw new Error("Expect input data series to contain at last 1 bar.");
    }

    const lookbackPeriod = strategy.lookbackPeriod || 1;
    if (inputSeries.count() < lookbackPeriod) {
        throw new Error("You have less input data than your lookback period, the size of your input data should be some multiple of your lookback period.");
    }

    const strategyParameters = strategy.parameters || {} as ParametersT;

    let indicatorsSeries: IDataFrame<IndexT, IndicatorBarT>;

    //
    // Prepare indicators.
    //
    if (strategy.prepIndicators) {
        indicatorsSeries = strategy.prepIndicators({
            parameters: strategyParameters, 
            inputSeries: inputSeries
        });
    }
    else {
        indicatorsSeries = inputSeries as IDataFrame<IndexT, IndicatorBarT>;
    }

    //
    // Tracks trades that have been closed.
    //
    const completedTrades: ITrade[] = [];
    
    //
    // Status of the position at any give time.
    //
    let positionStatus: PositionStatus = PositionStatus.None;

    //
    // Records the direction of a position/trade.
    //
    let positionDirection: TradeDirection = TradeDirection.Long;

    //
    // Records the price for conditional intrabar entry.
    //
    let conditionalEntryPrice: number | undefined;

    //
    // Tracks the currently open position, or set to null when there is no open position.
    //
    let openPosition: IPosition | null = null;

    //
    // Create a circular buffer to use for the lookback.
    //
    const lookbackBuffer = new CBuffer(lookbackPeriod);

    /**
     * User calls this function to enter a position on the instrument.
     */
    function enterPosition(options?: IEnterPositionOptions) {
        assert(positionStatus === PositionStatus.None, "Can only enter a position when not already in one.");

        positionStatus = PositionStatus.Enter; // Enter position next bar.
        positionDirection = options && options.direction || TradeDirection.Long;
        conditionalEntryPrice = options && options.entryPrice;
    }

    /**
     * User calls this function to exit a position on the instrument.
     */
    function exitPosition() {
        assert(positionStatus === PositionStatus.Position, "Can only exit a position when we are in a position.");

        positionStatus = PositionStatus.Exit; // Exit position next bar.
    }

    //
    // Close the current open position.
    //
    function closePosition(bar: InputBarT, exitPrice: number, exitReason: string) {
        const trade = finalizePosition(openPosition!, bar.time, exitPrice, exitReason);
        completedTrades.push(trade!);
        // Reset to no open position;
        openPosition = null;
        positionStatus = PositionStatus.None;
    }

    const positionManager = new PositionManager(strategy);

    for (const bar of indicatorsSeries) {
        positionManager.addBar(bar);
    }

    if (positionManager.openPosition) {
        const lastBar = indicatorsSeries.last();
        const lastTrade = finalizePosition(positionManager.openPosition, lastBar.time, lastBar.close, "finalize");
        positionManager.completedTrades.push(lastTrade);
    }

    return positionManager.completedTrades;
}

