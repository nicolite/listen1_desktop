/* eslint-disable no-unused-vars */
/* global angular MediaService sourceList */

angular.module('listenone').controller('PlayListController', [
  '$scope',
  '$timeout',
  ($scope) => {
    $scope.result = [];
    $scope.tab = sourceList[0].name;
    $scope.sourceList = sourceList;
    $scope.playlistFilters = {};
    $scope.allPlaylistFilters = {};
    $scope.currentFilterId = '';
    $scope.loading = true;
    $scope.showMore = false;
    // Tracks favorite (collected) state per featured-playlist card so the
    // card-level star button can toggle correctly. save_myplaylist('favorite')
    // does NOT dedupe, so we must not blindly re-clone an already-favorited list.
    $scope.favoritedIds = {};

    $scope.$on('infinite_scroll:hit_bottom', (event, data) => {
      if ($scope.loading === true) {
        return;
      }
      $scope.loading = true;
      const offset = $scope.result.length;
      MediaService.showPlaylistArray(
        $scope.tab,
        offset,
        $scope.currentFilterId
      ).success((res) => {
        $scope.result = $scope.result.concat(res.result);
        $scope.loading = false;
        refreshFavStates();
      });
    });

    $scope.loadPlaylist = () => {
      const offset = 0;
      $scope.showMore = false;
      MediaService.showPlaylistArray(
        $scope.tab,
        offset,
        $scope.currentFilterId
      ).success((res) => {
        $scope.result = res.result;
        $scope.loading = false;
        refreshFavStates();
      });

      if (
        $scope.playlistFilters[$scope.tab] === undefined &&
        $scope.allPlaylistFilters[$scope.tab] === undefined
      ) {
        MediaService.getPlaylistFilters($scope.tab).success((res) => {
          $scope.playlistFilters[$scope.tab] = res.recommend;
          $scope.allPlaylistFilters[$scope.tab] = res.all;
        });
      }
    };

    $scope.changeTab = (newTab) => {
      $scope.tab = newTab;
      $scope.result = [];
      $scope.currentFilterId = '';
      $scope.loadPlaylist();
    };

    $scope.changeFilter = (filterId) => {
      $scope.result = [];
      $scope.currentFilterId = filterId;
      $scope.loadPlaylist();
    };

    $scope.toggleMorePlaylists = () => {
      $scope.showMore = !$scope.showMore;
    };

    // Bulk-load the favorite (collected) state for the current card list.
    // queryPlaylist reads localStorage synchronously, so this is cheap and safe
    // to call on every (re)load and on infinite-scroll append.
    const refreshFavStates = () => {
      $scope.result.forEach((item) => {
        MediaService.queryPlaylist(item.id, 'favorite').success((res) => {
          $scope.favoritedIds[item.id] = res.result;
        });
      });
    };

    // Card-level star toggle. Reuses the NavigationController's
    // addFavoritePlaylist / removeFavoritePlaylist (clonePlaylist / removeMyPlaylist
    // under the hood) and keeps favoritedIds in sync to avoid duplicate clones.
    $scope.toggleCardFavorite = (i, event) => {
      if (event) {
        event.stopPropagation();
      }
      const id = i.id;
      if ($scope.favoritedIds[id]) {
        $scope.removeFavoritePlaylist(id);
        $scope.favoritedIds[id] = false;
      } else {
        $scope.addFavoritePlaylist(id);
        $scope.favoritedIds[id] = true;
      }
    };
  },
]);
