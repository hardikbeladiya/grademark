const CBuffer = require("CBuffer");
import { assert } from "chai";
import { DataFrame } from "data-forge";
import { EventEmitter } from "events";
import { max, min } from "mathjs";
import { IBacktestOptions } from "./backtest";
import { IBar } from "./bar";
import { IPosition } from "./position";
import { IEnterPositionOptions, IStrategy, TradeDirection } from "./strategy";
import { ITrade } from "./trade";

export enum PositionStatus {
  None,
  Enter,
  Position,
  Exit,
}

interface IEmissions {
  enterPosition: (data: {
    price: number;
    bar: IBar;
    position: IPosition;
    message: string;
  }) => void;
  exitPosition: (data: {
    price: number;
    bar: IBar;
    position: IPosition;
    message: string;
  }) => void;
  complete: (trades: ITrade[]) => void;
}

export class PositionManager<
  InputBarT extends IBar,
  IndicatorBarT extends InputBarT,
  ParametersT,
  IndexT
> extends EventEmitter {
  /** Status of the position at any give time. */
  private _positionStatus: PositionStatus = PositionStatus.None;
  public get positionStatus(): PositionStatus {
    return this._positionStatus;
  }
  public set positionStatus(status: PositionStatus) {
    this._positionStatus = status;
  }

  /** Records the direction of a position/trade. */
  public positionDirection: TradeDirection = TradeDirection.Long;
  /** Records the price for conditional intrabar entry. */
  public conditionalEntryPrice: number | undefined;
  /** Strategy lookback period. */
  public lookbackPeriod = 1;
  /** Tracks trades that have been closed. */
  public completedTrades: ITrade[] = [];
  /** Create a circular buffer to use for the lookback. */
  public lookbackBuffer = new CBuffer(1);
  /** Keep track of the highest price while in a position */
  public highestPrice: number = 0;

  private _options: IBacktestOptions = {};
  public get options(): IBacktestOptions {
    return this._options;
  }
  public set options(options: IBacktestOptions) {
    this._options = options;
  }

  private _strategy!: IStrategy<InputBarT, IndicatorBarT, ParametersT, IndexT>;
  public get strategy(): IStrategy<
    InputBarT,
    IndicatorBarT,
    ParametersT,
    IndexT
  > {
    return this._strategy;
  }
  public set strategy(
    strategy: IStrategy<InputBarT, IndicatorBarT, ParametersT, IndexT>
  ) {
    this._strategy = strategy;
  }

  public get strategyParameters(): ParametersT {
    return this.strategy.parameters || ({} as ParametersT);
  }

  private _openPosition: IPosition | null = null;
  public get openPosition(): IPosition | null {
    return this._openPosition;
  }
  public set openPosition(position: IPosition | null) {
    this._openPosition = position;
  }

  private _untypedOn = this.on;
  private _untypedEmit = this.emit;
  public on = <K extends keyof IEmissions>(
    event: K,
    listener: IEmissions[K]
  ): this => this._untypedOn(event, listener);
  public emit = <K extends keyof IEmissions>(
    event: K,
    ...args: Parameters<IEmissions[K]>
  ): boolean => this._untypedEmit(event, ...args);

  constructor(
    strategy: IStrategy<InputBarT, IndicatorBarT, ParametersT, IndexT>,
    options?: IBacktestOptions
  ) {
    super();
    this.strategy = strategy;
    this.lookbackPeriod = this.strategy.lookbackPeriod || 1;
    this.lookbackBuffer = new CBuffer(this.lookbackPeriod);
    if (options) {
      this.options = options;
    }
  }

  /**
   * Add a bar and process to determine if a trade should execute
   * @param bar
   * @returns
   */
  public addBar(bar: IndicatorBarT) {
    this.lookbackBuffer.push(bar);

    if (this.lookbackBuffer.length < this.lookbackPeriod) {
      return; // Don't invoke rules until lookback period is satisfied.
    }

    switch (+this.positionStatus) {
      case PositionStatus.None:
        this.strategy.entryRule(this._enterPosition, {
          bar: bar,
          lookback: new DataFrame<number, IndicatorBarT>(
            this.lookbackBuffer.data
          ),
          parameters: this.strategyParameters,
        });
        break;

      case PositionStatus.Enter:
        assert(
          this.openPosition === null,
          "Expected there to be no open position initialized yet!"
        );

        if (this.conditionalEntryPrice !== undefined) {
          // Must breach conditional entry price before entering position.
          if (this.positionDirection === TradeDirection.Long) {
            if (bar.high < this.conditionalEntryPrice) {
              break;
            }
          } else {
            if (bar.low > this.conditionalEntryPrice) {
              break;
            }
          }
        }

        const entryPrice = bar.open;

        this.openPosition = {
          direction: this.positionDirection,
          entryTime: bar.time,
          entryPrice: entryPrice,
          growth: 1,
          profit: 0,
          profitPct: 0,
          holdingPeriod: 0,
          maxPriceRecorded: entryPrice
        };

        if (this.strategy.stopLoss) {
          const initialStopDistance = this.strategy.stopLoss({
            entryPrice: entryPrice,
            position: this.openPosition,
            bar: bar,
            lookback: new DataFrame<number, InputBarT>(
              this.lookbackBuffer.data
            ),
            parameters: this.strategyParameters,
          });
          this.openPosition.initialStopPrice =
            this.openPosition.direction === TradeDirection.Long
              ? entryPrice - initialStopDistance
              : entryPrice + initialStopDistance;
          this.openPosition.curStopPrice = this.openPosition.initialStopPrice;
        }

        if (this.strategy.trailingStopLoss) {
          const trailingStopDistance = this.strategy.trailingStopLoss({
            entryPrice: entryPrice,
            position: this.openPosition,
            bar: bar,
            lookback: new DataFrame<number, InputBarT>(
              this.lookbackBuffer.data
            ),
            parameters: this.strategyParameters,
          });

          const trailingStopPrice =
            this.openPosition.direction === TradeDirection.Long
              ? entryPrice - trailingStopDistance
              : entryPrice + trailingStopDistance;

          if (this.openPosition.initialStopPrice === undefined) {
            this.openPosition.initialStopPrice = trailingStopPrice;
          } else {
            this.openPosition.initialStopPrice =
              this.openPosition.direction === TradeDirection.Long
                ? Math.max(
                    this.openPosition.initialStopPrice,
                    trailingStopPrice
                  )
                : Math.min(
                    this.openPosition.initialStopPrice,
                    trailingStopPrice
                  );
          }

          this.openPosition.curStopPrice = this.openPosition.initialStopPrice;

          if (this.options.recordStopPrice) {
            this.openPosition.stopPriceSeries = [
              {
                time: bar.time,
                value: this.openPosition.curStopPrice,
              },
            ];
          }
        }

        if (this.openPosition.curStopPrice !== undefined) {
          this.openPosition.initialUnitRisk =
            this.openPosition.direction === TradeDirection.Long
              ? entryPrice - this.openPosition.curStopPrice
              : this.openPosition.curStopPrice - entryPrice;

          this.openPosition.initialRiskPct =
            (this.openPosition.initialUnitRisk / entryPrice) * 100;
            
          this.openPosition.curRiskPct = this.openPosition.initialRiskPct;
          this.openPosition.curRMultiple = 0;

          if (this.options.recordRisk) {
            this.openPosition.riskSeries = [
              {
                time: bar.time,
                value: this.openPosition.curRiskPct,
              },
            ];
          }
        }

        if (this.strategy.profitTarget) {
          const profitDistance = this.strategy.profitTarget({
            entryPrice: entryPrice,
            position: this.openPosition,
            bar: bar,
            lookback: new DataFrame<number, InputBarT>(
              this.lookbackBuffer.data
            ),
            parameters: this.strategyParameters,
          });
          this.openPosition.profitTarget =
            this.openPosition.direction === TradeDirection.Long
              ? entryPrice + profitDistance
              : entryPrice - profitDistance;
        }

        this.emit("enterPosition", {
          price: entryPrice,
          bar,
          position: this.openPosition,
          message: "enter",
        });
        this.positionStatus = PositionStatus.Position;
        break;

      case PositionStatus.Position:
        assert(
          this.openPosition !== null,
          "Expected open position to already be initialized!"
        );

        // Update the highest/lowest price
        if (this.openPosition!.direction === TradeDirection.Long) {
          this.openPosition!.maxPriceRecorded = max(bar.high, this.openPosition!.maxPriceRecorded);
        } else {
          this.openPosition!.maxPriceRecorded = min(bar.low, this.openPosition!.maxPriceRecorded);
        }

        if (this.openPosition!.curStopPrice !== undefined) {
          if (this.openPosition!.direction === TradeDirection.Long) {
            if (bar.low <= this.openPosition!.curStopPrice!) {
              // Exit intrabar due to stop loss.
              this._closePosition(
                bar,
                this.openPosition!.curStopPrice!,
                "stop-loss"
              );
              break;
            }
          } else {
            if (bar.high >= this.openPosition!.curStopPrice!) {
              // Exit intrabar due to stop loss.
              this._closePosition(
                bar,
                this.openPosition!.curStopPrice!,
                "stop-loss"
              );
              break;
            }
          }
        }

        // Revaluate trailing stop loss.
        if (this.strategy.trailingStopLoss !== undefined) {
          const trailingStopDistance = this.strategy.trailingStopLoss({
            entryPrice: this.openPosition!.entryPrice,
            position: this.openPosition!,
            bar: bar,
            lookback: new DataFrame<number, InputBarT>(
              this.lookbackBuffer.data
            ),
            parameters: this.strategyParameters,
          });

          if (this.openPosition!.direction === TradeDirection.Long) {
            const newTrailingStopPrice = bar.close - trailingStopDistance;
            if (newTrailingStopPrice > this.openPosition!.curStopPrice!) {
              this.openPosition!.curStopPrice = newTrailingStopPrice;
            }
          } else {
            const newTrailingStopPrice = bar.close + trailingStopDistance;
            if (newTrailingStopPrice < this.openPosition!.curStopPrice!) {
              this.openPosition!.curStopPrice = newTrailingStopPrice;
            }
          }

          if (this.options.recordStopPrice) {
            this.openPosition!.stopPriceSeries!.push({
              time: bar.time,
              value: this.openPosition!.curStopPrice!,
            });
          }
        }

        if (this.openPosition!.profitTarget !== undefined) {
          if (this.openPosition!.direction === TradeDirection.Long) {
            if (bar.high >= this.openPosition!.profitTarget!) {
              // Exit intrabar due to profit target.
              this._closePosition(
                bar,
                this.openPosition!.profitTarget!,
                "profit-target"
              );
              break;
            }
          } else {
            if (bar.low <= this.openPosition!.profitTarget!) {
              // Exit intrabar due to profit target.
              this._closePosition(
                bar,
                this.openPosition!.profitTarget!,
                "profit-target"
              );
              break;
            }
          }
        }

        this._updatePosition(this.openPosition!, bar);

        if (
          this.openPosition!.curRiskPct !== undefined &&
          this.options.recordRisk
        ) {
          this.openPosition!.riskSeries!.push({
            time: bar.time,
            value: this.openPosition!.curRiskPct!,
          });
        }

        if (this.strategy.exitRule) {
          this.strategy.exitRule(this._exitPosition, {
            entryPrice: this.openPosition!.entryPrice,
            position: this.openPosition!,
            bar: bar,
            lookback: new DataFrame<number, IndicatorBarT>(
              this.lookbackBuffer.data
            ),
            parameters: this.strategyParameters,
          });
        }

        break;

      case PositionStatus.Exit:
        assert(
          this.openPosition !== null,
          "Expected open position to already be initialized!"
        );

        // NOTE: this happens on the NEXT bar
        // but it uses the open price (the closing of the last bar)
        this._closePosition(bar, bar.open, "exit-rule");
        break;

      default:
        throw new Error("Unexpected state!");
    }
  }

  /**
   * Complete the position, adding the last trade if necessary
   * @param lastBar
   */
  public complete(lastBar: IndicatorBarT, message = "finalize") {
    if (this.openPosition) {
      const lastTrade = this.finalizePosition(
        this.openPosition,
        lastBar.time,
        lastBar.close,
        message
      );
      this.emit("exitPosition", {
        price: lastBar.close,
        bar: lastBar,
        position: this.openPosition,
        message,
      });
      this.completedTrades.push(lastTrade);
    }
    this.emit("complete", this.completedTrades);
  }

  /**
   * User calls this function to enter a position on the instrument.
   *
   * @param options
   */
  private _enterPosition = (options?: IEnterPositionOptions) => {
    assert(
      this.positionStatus === PositionStatus.None,
      "Can only enter a position when not already in one."
    );

    this.positionStatus = PositionStatus.Enter; // Enter position next bar.
    this.positionDirection =
      (options && options.direction) || TradeDirection.Long;
    this.conditionalEntryPrice = options && options.entryPrice;
  };

  /**
   * User calls this function to exit a position on the instrument.
   */
  private _exitPosition = () => {
    assert(
      this.positionStatus === PositionStatus.Position,
      "Can only exit a position when we are in a position."
    );

    this.positionStatus = PositionStatus.Exit; // Exit position next bar.
  };

  /**
   * Close the current open position.
   *
   * @param bar
   * @param exitPrice
   * @param exitReason
   */
  private _closePosition(
    bar: InputBarT,
    exitPrice: number,
    exitReason: string
  ) {
    this.emit("exitPosition", {
      price: exitPrice,
      bar,
      position: this.openPosition!,
      message: exitReason,
    });

    const trade = this.finalizePosition(
      this.openPosition!,
      bar.time,
      exitPrice,
      exitReason
    );

    this.completedTrades.push(trade!);
    
    // Reset to no open position;
    this.openPosition = null;
    this.positionStatus = PositionStatus.None;
  }

  /**
   * Close a position that has been exited and produce a trade.
   *
   * @param position The position to close.
   * @param exitTime The timestamp for the bar when the position was exited.
   * @param exitPrice The price of the instrument when the position was exited.
   */
  public finalizePosition(
    position: IPosition,
    exitTime: Date,
    exitPrice: number,
    exitReason: string
  ): ITrade {
    const profit =
      position.direction === TradeDirection.Long
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
      growth:
        position.direction === TradeDirection.Long
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

  /**
   * Update an open position for a new bar.
   *
   * @param position The position to update.
   * @param bar The current bar.
   */
  private _updatePosition(position: IPosition, bar: IBar): void {
    position.profit = bar.close - position.entryPrice;
    position.profitPct = (position.profit / position.entryPrice) * 100;
    position.growth =
      position.direction === TradeDirection.Long
        ? bar.close / position.entryPrice
        : position.entryPrice / bar.close;
    if (position.curStopPrice !== undefined) {
      const unitRisk =
        position.direction === TradeDirection.Long
          ? bar.close - position.curStopPrice
          : position.curStopPrice - bar.close;
      position.curRiskPct = (unitRisk / bar.close) * 100;
      position.curRMultiple = position.profit / unitRisk;
    }
    position.holdingPeriod += 1;

    this.openPosition = position;
  }
}
