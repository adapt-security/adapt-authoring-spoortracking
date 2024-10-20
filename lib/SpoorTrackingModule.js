import { AbstractModule } from 'adapt-authoring-core'
/**
 * Module for making course content compatible with spoor
 * @memberof spoortracking
 * @extends {AbstractModule}
 */
class SpoorTrackingModule extends AbstractModule {
  /** @override */
  async init () {
    const [auth, content, server] = await this.app.waitForModule('auth', 'content', 'server')

    content.preInsertHook.tap(this.insertTrackingId.bind(this))

    server.api.createChildRouter('spoortracking').addRoute({
      route: '/reset/:_courseId',
      handlers: { post: this.resetTrackingHandler.bind(this) },
      meta: {
        post: {
          summary: 'Reset course tracking IDs',
          description: 'Fully resets all tracking IDs for a single course.',
          responses: { 204: {} }
        }
      }
    })
    auth.secureRoute('/api/spoortracking/reset/:_courseId', 'post', ['write:content'])
  }

  /**
   * Adds the latest tracking ID to a block
   * @param {Object} data The block data to update
   */
  async insertTrackingId (data) {
    if (data._type !== 'block' || Number.isInteger(data._trackingId)) {
      return
    }
    const content = await this.app.waitForModule('content')
    const [{ _trackingId }] = await content.find({ _courseId: data._courseId }, {}, { limit: 1, sort: [['_trackingId', -1]] })
    data._trackingId = (_trackingId ?? 0) + 1
  }

  /**
   * Resets all tracking IDs for a single course
   * @param {String} _courseId The course _id
   * @return {Promise}
   */
  async resetCourseTrackingIds (_courseId) {
    const content = await this.app.waitForModule('content')
    const blocks = await content.find({ _type: 'block', _courseId }, {}, { sort: [['_trackingId', 1]] })
    await Promise.all(blocks.map((b, i) => content.update({ _id: b._id }, { _trackingId: i + 1 }, { schemaName: 'block' })))
    this.log('debug', 'RESET', _courseId)
  }

  /**
   * Express handler for reseting all tracking IDs for a single course
   * @param {external:ExpressRequest} req
   * @param {external:ExpressResponse} res
   * @param {Function} next
   */
  async resetTrackingHandler (req, res, next) {
    try {
      await this.resetCourseTrackingIds(req.params._courseId)
      res.sendStatus(204)
    } catch (e) {
      return next(e)
    }
  }
}

export default SpoorTrackingModule
