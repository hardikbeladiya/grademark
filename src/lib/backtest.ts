import { IDataFrame } from 'data-forge';
import { IBar, IStrategy } from "..";
import { PositionManager } from "./position-manager";
import { ITrade } from "./trade";
import { isObject } from "./utils";

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

    const positionManager = new PositionManager(strategy, options);

    for (const bar of indicatorsSeries) {
        positionManager.addBar(bar);
    }

    positionManager.complete(indicatorsSeries.last())

    return positionManager.completedTrades;
}

