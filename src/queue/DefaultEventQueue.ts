import { Configuration } from '../configuration/Configuration';
import { SubmissionResponse } from '../submission/SubmissionResponse';
import { IEvent } from '../models/IEvent';
import { IEventQueue } from '../queue/IEventQueue';
import { Utils } from '../Utils';

export class DefaultEventQueue implements IEventQueue {
  private _config:Configuration;
  private _suspendProcessingUntil:Date;
  private _discardQueuedItemsUntil:Date;
  private _processingQueue:boolean = false;
  private _queueTimer:any;

  constructor(config:Configuration) {
    this._config = config;
  }

  public enqueue(event:IEvent): void {
    this.ensureQueueTimer();

    if (this.areQueuedItemsDiscarded()) {
      this._config.log.info('Queue items are currently being discarded. The event will not be queued.');
      return;
    }

    var key = `${this.queuePath()}-${new Date().toJSON()}-${Utils.randomNumber()}`;
    this._config.log.info(`Enqueuing event: ${key} type=${event.type} ${!!event.reference_id ? 'refid=' + event.reference_id : ''}`);
    this._config.storage.save(key, event);
  }

  public process(): void {
    this.ensureQueueTimer();

    if (this._processingQueue) {
      return;
    }

    var queueNotProcessed = 'The queue will not be processed.';
    this._config.log.info('Processing queue...');
    if (!this._config.enabled) {
      this._config.log.info(`Configuration is disabled. ${queueNotProcessed}`);
      return;
    }

    if (!this._config.apiKey || this._config.apiKey.length < 10) {
      this._config.log.info(`Invalid Api Key. ${queueNotProcessed}`);
      return;
    }

    this._processingQueue = true;

    try {
      var events = this._config.storage.get(this.queuePath(), this._config.submissionBatchSize);
      if (!events || events.length == 0) {
        this._processingQueue = false;
        return;
      }

      this._config.log.info(`Sending ${events.length} events to ${this._config.serverUrl}.`);
      this._config.submissionClient.submit(events, this._config, (response:SubmissionResponse) => {
        this.processSubmissionResponse(response, events);
        this._config.log.info('Finished processing queue.');
        this._processingQueue = false;
      });
    } catch (ex) {
      this._config.log.error(`Error processing queue: ${ex}`);
      this.suspendProcessing();
      this._processingQueue = false;
    }
  }

  private processSubmissionResponse(response:SubmissionResponse, events:IEvent[]): void {
    var noSubmission = 'The event will not be submitted.';
    if (response.success) {
      this._config.log.info(`Sent ${events.length} events.`);
      return;
    }

    if (response.serviceUnavailable) {
      // You are currently over your rate limit or the servers are under stress.
      this._config.log.error('Server returned service unavailable.');
      this.suspendProcessing();
      this.requeueEvents(events);
      return;
    }

    if (response.paymentRequired) {
      // If the organization over the rate limit then discard the event.
      this._config.log.info('Too many events have been submitted, please upgrade your plan.');
      this.suspendProcessing(null, true, true);
      return;
    }

    if (response.unableToAuthenticate) {
      // The api key was suspended or could not be authorized.
      this._config.log.info(`Unable to authenticate, please check your configuration. ${noSubmission}`);
      this.suspendProcessing(15);
      return;
    }

    if (response.notFound || response.badRequest) {
      // The service end point could not be found.
      this._config.log.error(`Error while trying to submit data: ${response.message}`);
      this.suspendProcessing(60 * 4);
      return;
    }

    if (response.requestEntityTooLarge) {
      var message = 'Event submission discarded for being too large.';
      if (this._config.submissionBatchSize > 1) {
        this._config.log.error(`${message} Retrying with smaller batch size.`);
        this._config.submissionBatchSize = Math.max(1, Math.round(this._config.submissionBatchSize / 1.5));
        this.requeueEvents(events);
      } else {
        this._config.log.error(`${message} ${noSubmission}`);
      }

      return;
    }

    if (!response.success) {
      this._config.log.error(`Error submitting events: ${ response.message}`);
      this.suspendProcessing();
      this.requeueEvents(events);
    }
  }

  private ensureQueueTimer(): void {
    if (!this._queueTimer) {
      this._queueTimer = setInterval(() => this.onProcessQueue(), 10000);
    }
  }

  private onProcessQueue(): void {
    if (!this.isQueueProcessingSuspended() && !this._processingQueue) {
      this.process();
    }
  }

  public suspendProcessing(durationInMinutes?:number, discardFutureQueuedItems?:boolean, clearQueue?:boolean): void {
    if (!durationInMinutes || durationInMinutes <= 0) {
      durationInMinutes = 5;
    }

    this._config.log.info(`Suspending processing for ${durationInMinutes} minutes.`);
    this._suspendProcessingUntil = new Date(new Date().getTime() + (durationInMinutes * 60000));

    if (discardFutureQueuedItems) {
      this._discardQueuedItemsUntil = new Date(new Date().getTime() + (durationInMinutes * 60000));
    }

    if (!clearQueue) {
      return;
    }

    // Account is over the limit and we want to ensure that the sample size being sent in will contain newer errors.
    try {
      this._config.storage.clear(this.queuePath());
    } catch (Exception) { }
  }

  private requeueEvents(events:IEvent[]): void {
    this._config.log.info(`Requeuing ${events.length} events.`);

    for (var index = 0; index < events.length; index++) {
      this.enqueue(events[index]);
    }
  }

  private isQueueProcessingSuspended(): boolean {
    return this._suspendProcessingUntil && this._suspendProcessingUntil > new Date();
  }

  private areQueuedItemsDiscarded(): boolean {
    return this._discardQueuedItemsUntil && this._discardQueuedItemsUntil > new Date();
  }

  private queuePath(): string {
    return 'ex-q';
  }
}
