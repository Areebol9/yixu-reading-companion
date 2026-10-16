package com.yixu.reading;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/** Evidence of a single vertical reading flow inside the already-cropped image. */
final class ReadingLayout {
    static final class Line {
        final int left, top, right, bottom, characters;
        Line(int left,int top,int right,int bottom,int characters){this.left=left;this.top=top;this.right=right;this.bottom=bottom;this.characters=characters;}
        int height(){return bottom-top;}
    }
    static boolean singleColumn(List<Line> input,int width,int height){
        if(width<=0||height<=0)return false;
        List<Line> lines=new ArrayList<>();
        for(Line line:input)if(line.characters>=8&&line.left>=0&&line.top>=0&&line.right<=width&&line.bottom<=height&&line.right>line.left&&line.height()>0)lines.add(line);
        if(lines.size()<3)return false;
        List<Integer> heights=new ArrayList<>();for(Line line:lines)heights.add(line.height());heights.sort(Integer::compare);
        int median=heights.get(heights.size()/2);
        lines.removeIf(line->line.height()<median*.7||line.height()>median*1.4);
        if(lines.size()<3)return false;
        lines.sort(Comparator.comparingInt((Line line)->line.top).thenComparingInt(line->line.left));
        int broad=0;Line previous=null;
        for(Line line:lines){
            if(line.left>width*.4)return false;
            if(line.right-line.left>=width*.55)broad++;
            if(previous!=null&&(line.top<previous.bottom-Math.min(line.height(),previous.height())*.35||line.top-previous.bottom>median*4))return false;
            previous=line;
        }
        return broad>=2&&broad*2>=lines.size();
    }
}
